/* Supabase configuration. The publishable key is safe to expose in client-side code;
   the actual security comes from Row Level Security policies in the database. */
window.REFLECT_CONFIG = {
  SUPABASE_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co',
  SUPABASE_KEY: 'sb_publishable_AVb4KY5cTUdtMbltuiRPUg_YOdfNVvi',

  /* AI Assistant mode:
       'off'  — uses the simple rule-based answers (no API cost, current behavior)
       'live' — calls the deployed Supabase Edge Function 'ai-assistant'
                Requires: Anthropic API key set as a Supabase secret AND the
                Edge Function deployed. See supabase/functions/ai-assistant/. */
  AI_MODE: 'off',
  AI_FUNCTION_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co/functions/v1/ai-assistant'
};
