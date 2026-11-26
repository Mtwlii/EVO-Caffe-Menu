// EVO data backend config. The anon key is public by design (Supabase row level
// security protects writes); it is NOT a secret. Leave url/anonKey empty to run
// the menu fully offline from the static HTML (overrides disabled).
window.EVO_DATA = {
  url: '',      // e.g. 'https://xyzcompany.supabase.co'
  anonKey: ''   // Supabase anon (public) key
};
