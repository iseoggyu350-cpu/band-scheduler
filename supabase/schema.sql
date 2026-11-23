-- =============================================================================
-- 밴드 합주 시간표 · Supabase 데이터베이스 설정 (v2: 아이디/비밀번호 로그인)
--
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run.
--         여러 번 실행해도 안전합니다 (이미 있는 데이터는 지우지 않아요).
--         예전(v1) 버전을 이미 실행했다면 이 파일을 한 번 더 실행하면 v2로 바뀌어요.
--
-- 구조
--   clubs     : 소속(교내 밴드부). 관리자 코드로만 추가/수정/삭제할 수 있어요.
--   profiles  : 가입한 사람의 아이디 · 이름 · 기본 파트 · 소속 밴드부.
--   teams     : 밴드부 안의 팀(곡별 팀, 고정 팀). 로그인한 사람 누구나 만들 수 있고,
--               팀 설정(이름·기간·삭제)은 그 팀 멤버만 바꿀 수 있어요.
--   members   : 팀 멤버와 그 팀에서의 가능 시간. 팀마다 따로 저장돼요.
--               user_id 가 있으면 그 계정 본인만, 없으면(게스트) 그 팀 멤버들이 고칠 수 있어요.
--   app_admin : 관리자 코드(해시). 앱에서는 절대 읽을 수 없어요.
--
-- 로그인하지 않은 사람은 밴드부 목록만 볼 수 있어요 (가입할 때 고르기 위해).
-- =============================================================================

-- 가능 시간 칸 형식 검사: "2026-11-23T19" = 2026년 11월 23일 19:00~20:00
create or replace function public.slots_are_valid(arr text[])
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and(s is not null and s ~ '^\d{4}-\d{2}-\d{2}T([0-9]|1[0-9]|2[0-3])$'), true)
  from unnest(arr) as s
$$;

-- -----------------------------------------------------------------------------
-- 테이블
-- -----------------------------------------------------------------------------
create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 30),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists clubs_name_unique on public.clubs (lower(btrim(name)));

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  color_idx smallint not null default 0 check (color_idx between 0 and 7),
  start_date date not null default current_date,
  week_count smallint not null default 4 check (week_count between 1 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists teams_club_id_idx on public.teams (club_id);
alter table public.teams add column if not exists created_by uuid references auth.users (id) on delete set null;

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 16),
  part text not null default '세션' check (part in ('보컬', '기타', '베이스', '드럼', '건반', '세션')),
  color_idx smallint not null default 0 check (color_idx between 0 and 7),
  sort_order integer not null default 0,
  slots text[] not null default '{}' check (cardinality(slots) <= 4000 and public.slots_are_valid(slots)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists members_team_id_idx on public.members (team_id);
alter table public.members add column if not exists user_id uuid references auth.users (id) on delete set null;
-- 한 계정은 한 팀에 한 번만
create unique index if not exists members_team_user_unique on public.members (team_id, user_id) where user_id is not null;
create index if not exists members_user_id_idx on public.members (user_id);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 16),
  part text not null default '세션' check (part in ('보컬', '기타', '베이스', '드럼', '건반', '세션')),
  club_id uuid references public.clubs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_username_unique on public.profiles (username);

create table if not exists public.app_admin (
  id boolean primary key default true check (id),
  salt text not null,
  code_hash text not null,
  updated_at timestamptz not null default now()
);

-- updated_at 자동 갱신
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists teams_touch_updated_at on public.teams;
create trigger teams_touch_updated_at before update on public.teams
  for each row execute function public.touch_updated_at();

drop trigger if exists members_touch_updated_at on public.members;
create trigger members_touch_updated_at before update on public.members
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 가입하면 profiles 한 줄을 자동으로 만듭니다 (아이디는 로그인용 이메일 앞부분)
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_club uuid;
  v_part text := meta ->> 'part';
begin
  begin
    v_club := nullif(meta ->> 'club_id', '')::uuid;
  exception when others then
    v_club := null;
  end;
  if v_club is not null and not exists (select 1 from public.clubs where id = v_club) then
    v_club := null;
  end if;
  if v_part is null or v_part not in ('보컬', '기타', '베이스', '드럼', '건반', '세션') then
    v_part := '세션';
  end if;
  insert into public.profiles (id, username, display_name, part, club_id)
  values (
    new.id,
    lower(split_part(new.email, '@', 1)),
    left(coalesce(nullif(btrim(meta ->> 'display_name'), ''), split_part(new.email, '@', 1)), 16),
    v_part,
    v_club
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 이름을 바꾸면 내가 들어가 있는 모든 팀의 멤버 이름도 같이 바뀌어요
create or replace function public.sync_member_names()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.display_name is distinct from old.display_name then
    update public.members set name = new.display_name where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sync_member_names on public.profiles;
create trigger profiles_sync_member_names after update on public.profiles
  for each row execute function public.sync_member_names();

-- 내가 이 팀 멤버인가? (보안 규칙에서 사용)
create or replace function public.is_team_member(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.members where team_id = p_team and user_id = auth.uid())
$$;

-- 멤버 보호: 팀을 옮기거나, 남의 계정에 연결된 멤버를 가로채지 못하게.
-- 계정에 연결된 멤버의 이름은 항상 그 계정의 이름으로 맞춥니다.
create or replace function public.members_guard()
returns trigger
language plpgsql
as $$
declare
  v_name text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new; -- 관리자 함수·계정 삭제 같은 서버 내부 작업
  end if;
  if tg_op = 'UPDATE' then
    if new.team_id <> old.team_id then
      raise exception 'MEMBER_TEAM_IMMUTABLE';
    end if;
    if old.user_id is not null and new.user_id is distinct from old.user_id then
      raise exception 'MEMBER_OWNER_IMMUTABLE';
    end if;
  end if;
  if new.user_id is not null and new.user_id = auth.uid() then
    select p.display_name into v_name from public.profiles p where p.id = auth.uid();
    if v_name is not null then
      new.name := v_name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists members_guard on public.members;
create trigger members_guard before insert or update on public.members
  for each row execute function public.members_guard();

-- -----------------------------------------------------------------------------
-- 접근 권한 (Row Level Security)
-- -----------------------------------------------------------------------------
alter table public.clubs enable row level security;
alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.profiles enable row level security;
alter table public.app_admin enable row level security;

revoke all on public.clubs, public.teams, public.members, public.profiles, public.app_admin from anon, authenticated;
grant select on public.clubs to anon, authenticated;
grant select, insert, update, delete on public.teams, public.members to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, part, club_id) on public.profiles to authenticated;

drop policy if exists clubs_select on public.clubs;
create policy clubs_select on public.clubs for select to anon, authenticated using (true);

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists teams_select on public.teams;
drop policy if exists teams_insert on public.teams;
drop policy if exists teams_update on public.teams;
drop policy if exists teams_delete on public.teams;
create policy teams_select on public.teams for select to authenticated using (true);
create policy teams_insert on public.teams for insert to authenticated with check (created_by = auth.uid());
create policy teams_update on public.teams for update to authenticated
  using (public.is_team_member(id) or created_by = auth.uid())
  with check (true);
create policy teams_delete on public.teams for delete to authenticated
  using (public.is_team_member(id) or created_by = auth.uid());

drop policy if exists members_select on public.members;
drop policy if exists members_insert on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
create policy members_select on public.members for select to authenticated using (true);
-- 나를 추가(참여)하거나, 내가 멤버인 팀에 게스트를 추가
create policy members_insert on public.members for insert to authenticated
  with check (user_id = auth.uid() or (user_id is null and public.is_team_member(team_id)));
-- 내 멤버는 나만. 게스트는 팀 멤버가 고치거나, 누구든 "이게 나예요"로 이어받기(user_id = 나)
create policy members_update on public.members for update to authenticated
  using (user_id = auth.uid() or user_id is null)
  with check (user_id = auth.uid() or (user_id is null and public.is_team_member(team_id)));
create policy members_delete on public.members for delete to authenticated
  using (user_id = auth.uid() or (user_id is null and public.is_team_member(team_id)));

-- -----------------------------------------------------------------------------
-- 관리자 기능 (관리자 코드를 아는 사람만)
-- -----------------------------------------------------------------------------
create or replace function public._admin_hash(p_salt text, p_code text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(p_salt || ':' || coalesce(p_code, ''), 'UTF8')), 'hex')
$$;

create or replace function public._admin_ok(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.app_admin a
    where a.code_hash = public._admin_hash(a.salt, p_code)
  )
$$;

create or replace function public._admin_require(p_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._admin_ok(p_code) then
    perform pg_sleep(0.5); -- 코드 마구 넣어보기를 느리게
    raise exception 'ADMIN_CODE_INVALID' using errcode = '28000';
  end if;
end;
$$;

-- SQL Editor 에서만 실행: 관리자 코드 설정/재설정
--   select public.set_admin_code('원하는코드');
create or replace function public.set_admin_code(p_new_code text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_salt text := md5(random()::text || clock_timestamp()::text);
begin
  if p_new_code is null or char_length(btrim(p_new_code)) < 4 then
    raise exception '관리자 코드는 4글자 이상이어야 해요';
  end if;
  insert into public.app_admin (id, salt, code_hash, updated_at)
  values (true, v_salt, public._admin_hash(v_salt, btrim(p_new_code)), now())
  on conflict (id) do update
    set salt = excluded.salt, code_hash = excluded.code_hash, updated_at = now();
  return '관리자 코드를 설정했어요';
end;
$$;

create or replace function public.admin_is_configured()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.app_admin)
$$;

create or replace function public.admin_verify(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public._admin_ok(btrim(coalesce(p_code, ''))) then
    return true;
  end if;
  perform pg_sleep(0.5);
  return false;
end;
$$;

create or replace function public.admin_create_club(p_code text, p_name text)
returns public.clubs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.clubs;
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  insert into public.clubs (name, sort_order)
  values (btrim(p_name), coalesce((select max(sort_order) + 1 from public.clubs), 0))
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.admin_rename_club(p_code text, p_id uuid, p_name text)
returns public.clubs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.clubs;
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  update public.clubs set name = btrim(p_name) where id = p_id returning * into v_row;
  if v_row.id is null then
    raise exception 'CLUB_NOT_FOUND';
  end if;
  return v_row;
end;
$$;

create or replace function public.admin_move_club(p_code text, p_id uuid, p_direction integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_pos integer;
  v_swap integer;
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  select array_agg(id order by sort_order, created_at) into v_ids from public.clubs;
  v_pos := array_position(v_ids, p_id);
  if v_pos is null then
    raise exception 'CLUB_NOT_FOUND';
  end if;
  v_swap := v_pos + sign(p_direction)::integer;
  if v_swap < 1 or v_swap > cardinality(v_ids) then
    return;
  end if;
  v_ids[v_pos] := v_ids[v_swap];
  v_ids[v_swap] := p_id;
  update public.clubs c set sort_order = t.ord - 1
  from unnest(v_ids) with ordinality as t(id, ord)
  where c.id = t.id;
end;
$$;

create or replace function public.admin_delete_club(p_code text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  delete from public.clubs where id = p_id;
end;
$$;

create or replace function public.admin_change_code(p_code text, p_new_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  perform public.set_admin_code(p_new_code);
end;
$$;

-- 계정 목록 (아이디 · 이름 · 밴드부 · 참여 팀 수)
create or replace function public.admin_list_users(p_code text)
returns table (id uuid, username text, display_name text, club_name text, team_count integer, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  return query
    select p.id, p.username, p.display_name, c.name,
           (select count(*)::integer from public.members m where m.user_id = p.id),
           p.created_at
    from public.profiles p
    left join public.clubs c on c.id = p.club_id
    order by p.username;
end;
$$;

-- 비밀번호 초기화 (비밀번호를 잊은 학생용)
create or replace function public.admin_reset_password(p_code text, p_user_id uuid, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  if p_new_password is null or char_length(p_new_password) < 6 then
    raise exception 'PASSWORD_TOO_SHORT';
  end if;
  update auth.users
    set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
        updated_at = now()
    where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
end;
$$;

-- 계정 삭제: 그 사람이 들어가 있던 팀 멤버는 게스트로 남아요 (시간도 그대로)
create or replace function public.admin_delete_user(p_code text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  delete from auth.users where id = p_user_id;
end;
$$;

-- 팀 목록 / 팀 삭제 (멤버가 아무도 관리하지 않는 팀 정리용)
create or replace function public.admin_list_teams(p_code text)
returns table (id uuid, name text, club_name text, member_count integer, account_count integer, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  return query
    select t.id, t.name, c.name,
           (select count(*)::integer from public.members m where m.team_id = t.id),
           (select count(*)::integer from public.members m where m.team_id = t.id and m.user_id is not null),
           t.created_at
    from public.teams t
    join public.clubs c on c.id = t.club_id
    order by c.sort_order, c.name, t.created_at desc;
end;
$$;

create or replace function public.admin_delete_team(p_code text, p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._admin_require(btrim(coalesce(p_code, '')));
  delete from public.teams where id = p_team_id;
end;
$$;

-- 함수 실행 권한: 내부용/설정용은 막고, 앱에서 쓰는 것만 열어둡니다.
revoke execute on function public._admin_ok(text) from public, anon, authenticated;
revoke execute on function public._admin_require(text) from public, anon, authenticated;
revoke execute on function public._admin_hash(text, text) from public, anon, authenticated;
revoke execute on function public.set_admin_code(text) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.sync_member_names() from public, anon, authenticated;
revoke execute on function public.is_team_member(uuid) from public, anon;
grant execute on function public.is_team_member(uuid) to authenticated;
grant execute on function public.admin_is_configured() to anon, authenticated;
grant execute on function public.admin_verify(text) to anon, authenticated;
grant execute on function public.admin_create_club(text, text) to anon, authenticated;
grant execute on function public.admin_rename_club(text, uuid, text) to anon, authenticated;
grant execute on function public.admin_move_club(text, uuid, integer) to anon, authenticated;
grant execute on function public.admin_delete_club(text, uuid) to anon, authenticated;
grant execute on function public.admin_change_code(text, text) to anon, authenticated;
grant execute on function public.admin_list_users(text) to anon, authenticated;
grant execute on function public.admin_reset_password(text, uuid, text) to anon, authenticated;
grant execute on function public.admin_delete_user(text, uuid) to anon, authenticated;
grant execute on function public.admin_list_teams(text) to anon, authenticated;
grant execute on function public.admin_delete_team(text, uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 실시간 반영 (다른 사람이 입력한 시간이 바로 보이도록)
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['clubs', 'teams', 'members'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception
        when duplicate_object then null;
        when others then raise notice '실시간 설정 건너뜀 (%): %', t, sqlerrm;
      end;
    end loop;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 처음 설치했다면: 새 쿼리 창에서 아래 한 줄을 코드만 바꿔서 실행하세요.
--
--   select public.set_admin_code('여기에-관리자-코드');
--
-- 그리고 Authentication → Sign In / Providers → Email 에서 "Confirm email" 을 꺼주세요.
-- (아이디로 가입하는 방식이라 실제 이메일 확인을 할 수 없어요)
-- -----------------------------------------------------------------------------
