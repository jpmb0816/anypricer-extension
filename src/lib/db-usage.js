// Online database size, shown in the popup and in Settings → Online database
export function usageInfo(u) {
  if (!u || u.state === 'off') return null;
  if (u.state === 'missing') return { cls: 'muted', text: 'Database size: needs the db_usage() update in Supabase' };
  if (u.state !== 'ok') return { cls: 'muted', text: 'Database size: unavailable' };
  const mb = (b) => (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + ' MB';
  const pct = Math.round((u.bytes / u.limit) * 100);
  return { cls: pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok', pct, text: `Online database: ${mb(u.bytes)} of ${mb(u.limit)} (${pct}%)${pct >= 80 ? ' · almost full' : ''}` };
}
