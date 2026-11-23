-- =============================================================================
-- 밴드 합주 시간표 · Supabase 데이터베이스 설정
--
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run.
--         여러 번 실행해도 안전합니다 (이미 있는 데이터는 지우지 않아요).
--
-- 구조
--   clubs   : 소속(교내 밴드부). 관리자 코드로만 추가/수정/삭제할 수 있어요.
--   teams   : 소속 안의 팀(곡별 팀, 고정 팀). 학생 누구나 만들고 고칠 수 있어요.
--   members : 팀 멤버와 그 팀에서의 가능 시간. 팀마다 따로 저장돼요.
--   app_admin : 관리자 코드(해시). 앱에서는 절대 읽을 수 없어요.
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

-- -----------------------------------------------------------------------------
-- 접근 권한 (Row Level Security)
--   앱은 공개 키(anon/publishable key)로 접속합니다.
--   clubs 는 읽기만, teams/members 는 읽기·쓰기 가능, app_admin 은 접근 불가.
-- -----------------------------------------------------------------------------
alter table public.clubs enable row level security;
alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.app_admin enable row level security;

revoke all on public.clubs, public.teams, public.members, public.app_admin from anon, authenticated;
grant select on public.clubs to anon, authenticated;
grant select, insert, update, delete on public.teams, public.members to anon, authenticated;

drop policy if exists clubs_select on public.clubs;
create policy clubs_select on public.clubs for select to anon, authenticated using (true);

drop policy if exists teams_select on public.teams;
drop policy if exists teams_insert on public.teams;
drop policy if exists teams_update on public.teams;
drop policy if exists teams_delete on public.teams;
create policy teams_select on public.teams for select to anon, authenticated using (true);
create policy teams_insert on public.teams for insert to anon, authenticated with check (true);
create policy teams_update on public.teams for update to anon, authenticated using (true) with check (true);
create policy teams_delete on public.teams for delete to anon, authenticated using (true);

drop policy if exists members_select on public.members;
drop policy if exists members_insert on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
create policy members_select on public.members for select to anon, authenticated using (true);
create policy members_insert on public.members for insert to anon, authenticated with check (true);
create policy members_update on public.members for update to anon, authenticated using (true) with check (true);
create policy members_delete on public.members for delete to anon, authenticated using (true);

-- -----------------------------------------------------------------------------
-- 관리자 기능 (관리자 코드를 아는 사람만 소속을 추가/수정/삭제)
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

-- 함수 실행 권한: 내부용/설정용은 막고, 앱에서 쓰는 것만 열어둡니다.
revoke execute on function public._admin_ok(text) from public, anon, authenticated;
revoke execute on function public._admin_require(text) from public, anon, authenticated;
revoke execute on function public._admin_hash(text, text) from public, anon, authenticated;
revoke execute on function public.set_admin_code(text) from public, anon, authenticated;
grant execute on function public.admin_is_configured() to anon, authenticated;
grant execute on function public.admin_verify(text) to anon, authenticated;
grant execute on function public.admin_create_club(text, text) to anon, authenticated;
grant execute on function public.admin_rename_club(text, uuid, text) to anon, authenticated;
grant execute on function public.admin_move_club(text, uuid, integer) to anon, authenticated;
grant execute on function public.admin_delete_club(text, uuid) to anon, authenticated;
grant execute on function public.admin_change_code(text, text) to anon, authenticated;

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
-- 다음 단계: 이 파일을 실행한 뒤, 새 쿼리 창에서 아래 한 줄을 코드만 바꿔서 실행하세요.
--
--   select public.set_admin_code('여기에-관리자-코드');
-- -----------------------------------------------------------------------------
