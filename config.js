// =============================================================================
// 밴드 합주 시간표 · 서버 설정 (관리자만 한 번 수정하면 됩니다)
//
// Supabase 대시보드 → 프로젝트 → Project Settings → API Keys (또는 Data API) 에서 복사하세요.
//   supabaseUrl : Project URL       예) 'https://abcdefghijklmn.supabase.co'
//   supabaseKey : Publishable key   예) 'sb_publishable_...'  (예전 프로젝트는 'anon public' 키, eyJ... 로 시작)
//
// ⚠️ 여기에는 "공개(publishable / anon)" 키만 넣으세요. secret / service_role 키는 절대 넣으면 안 됩니다.
//    공개 키는 원래 웹사이트에 들어가도 되는 키이고, 실제 권한은 supabase/schema.sql 의 보안 규칙이 막아줍니다.
// =============================================================================
window.BAND_SCHEDULER_CONFIG = {
  supabaseUrl: 'https://wndwnzsoespfejdqiiea.supabase.co',
  supabaseKey: 'sb_publishable_9tggPHEDb8s2lcXgAXzOcQ_v0ltOnqq',

  // 아이디 로그인용 도메인. Supabase 는 이메일 형식이 필요해서 '아이디@이 도메인' 으로 바꿔서 저장해요.
  // 실제로 메일을 보내지는 않아요. ⚠️ 한 번 정하면 바꾸지 마세요 (바꾸면 기존 계정으로 로그인할 수 없어요).
  loginEmailDomain: 'iseoggyu350-cpu.github.io'
};
