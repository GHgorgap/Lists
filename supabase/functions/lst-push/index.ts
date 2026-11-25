// Supabase Edge Function «lst-push» — ειδοποιήσεις της εφαρμογής «Λίστες» (web push)
//   {action:"key"}                          → δημόσιο κλειδί VAPID (για την εγγραφή συσκευής)
//   {action:"run"}                          → στέλνει ό,τι είναι έτοιμο στην ουρά lst_events (pg_cron κάθε λεπτό, ή η εφαρμογή)
//   {action:"test", space, endpoint}        → δοκιμαστική ειδοποίηση σε μία συσκευή
// Κανόνες:
//   add     → μαζεύονται ανά (λίστα, άτομο). Στέλνονται όταν περάσουν 5' χωρίς νέα προσθήκη ή όταν κλείσει την εφαρμογή (ready).
//   going   → «Πάω για ψώνια», αμέσως.   cleared → «Τα ψώνια έγιναν», αμέσως.
//   Ποτέ σε αυτόν που έκανε την αλλαγή. Όχι σε όσους έχουν σιγάσει τη λίστα (lst_mutes).
// Κλειδιά VAPID: private_kv (lst_vapid_public / lst_vapid_private), φτιάχνονται μόνα τους την πρώτη φορά.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const env = (k: string) => Deno.env.get(k) ?? ''
const APP = 'https://ghgorgap.github.io/Lists/'
const QUIET_MS = 5 * 60 * 1000

type Admin = ReturnType<typeof createClient>
type Sub = { endpoint: string; space: string; who: string; p256dh: string; auth: string }
type Ev = { id: number; space: string; list_id: string; who: string; kind: string; text: string | null; key: string | null; at: string; ready: boolean }

async function keys(admin: Admin): Promise<{ pub: string; priv: string }> {
  const { data } = await admin.from('private_kv').select('key, value').in('key', ['lst_vapid_public', 'lst_vapid_private'])
  const m = new Map(((data ?? []) as { key: string; value: string }[]).map(r => [r.key, r.value]))
  if (m.get('lst_vapid_public') && m.get('lst_vapid_private')) return { pub: m.get('lst_vapid_public')!, priv: m.get('lst_vapid_private')! }
  const k = webpush.generateVAPIDKeys()
  const { error } = await admin.from('private_kv').insert([{ key: 'lst_vapid_public', value: k.publicKey }, { key: 'lst_vapid_private', value: k.privateKey }])
  if (error) return keys(admin)
  return { pub: k.publicKey, priv: k.privateKey }
}
async function vapid(admin: Admin) { const k = await keys(admin); webpush.setVapidDetails('mailto:george.apost@gmail.com', k.pub, k.priv) }

async function send(admin: Admin, subs: Sub[], p: { title: string; body: string; url: string; tag: string }) {
  let ok = 0
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(p), { TTL: 6 * 3600, urgency: 'normal' })
      ok++
      await admin.from('lst_subs').update({ last_ok_at: new Date().toISOString() }).eq('endpoint', s.endpoint)
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) await admin.from('lst_subs').delete().eq('endpoint', s.endpoint)
      else { console.error('push', code, (e as Error).message); await admin.from('lst_errors').insert({ space: s.space, where_: 'push', msg: `${code} ${(e as Error).message}`.slice(0, 500) }) }
    }
  }
  return ok
}
const names = (xs: string[], max = 4) => xs.slice(0, max).join(', ') + (xs.length > max ? ` +${xs.length - max}` : '')

async function run(admin: Admin) {
  const { data: evs } = await admin.from('lst_events').select('*').is('sent_at', null).order('at').limit(500)
  const pending = (evs ?? []) as Ev[]
  if (!pending.length) return []
  await vapid(admin)
  const spaces = [...new Set(pending.map(e => e.space))]
  const [{ data: subRows }, { data: muteRows }, { data: listRows }] = await Promise.all([
    admin.from('lst_subs').select('*').in('space', spaces),
    admin.from('lst_mutes').select('*').in('space', spaces),
    admin.from('lst_lists').select('id, name').in('space', spaces),
  ])
  const subs = (subRows ?? []) as Sub[]
  const mutes = (muteRows ?? []) as { space: string; who: string; list_id: string }[]
  const listName = new Map(((listRows ?? []) as { id: string; name: string }[]).map(l => [l.id, l.name]))
  const to = (e: Ev) => subs.filter(s => s.space === e.space && s.who !== e.who && !mutes.some(m => m.space === e.space && m.list_id === e.list_id && m.who === s.who))
  const url = (e: Ev) => `${APP}?k=${encodeURIComponent(e.space)}&l=${e.list_id}`
  const who = (e: Ev) => e.who || 'Κάποιος'
  const report: string[] = []
  const done: number[] = []

  for (const e of pending.filter(e => e.kind !== 'add')) {
    const list = listName.get(e.list_id) ?? 'Λίστα'
    const p = e.kind === 'going'
      ? { title: `🛒 ${who(e)} πάει για ψώνια`, body: `${list}: πρόσθεσε τώρα ό,τι χρειάζεσαι.`, url: url(e), tag: `going-${e.list_id}` }
      : { title: `✓ Τα ψώνια έγιναν`, body: `${who(e)} τελείωσε το «${list}»${e.text ? ` (${e.text})` : ''}.`, url: url(e), tag: `cleared-${e.list_id}` }
    report.push(`${e.kind}→${await send(admin, to(e), p)}`)
    done.push(e.id)
  }

  const groups = new Map<string, Ev[]>()
  for (const e of pending.filter(e => e.kind === 'add')) { const k = `${e.space}|${e.list_id}|${e.who}`; groups.set(k, [...(groups.get(k) ?? []), e]) }
  for (const g of groups.values()) {
    const last = Math.max(...g.map(e => Date.parse(e.at)))
    if (!g.some(e => e.ready) && Date.now() - last < QUIET_MS) continue
    const e0 = g[0]
    // μόνο όσα είναι ακόμα στη λίστα και δεν έχουν αγοραστεί
    const { data: live } = await admin.from('lst_items').select('key, text').eq('list_id', e0.list_id).eq('done', false)
    const liveMap = new Map(((live ?? []) as { key: string; text: string }[]).map(r => [r.key, r.text]))
    const seen = new Set<string>(); const items: string[] = []
    for (const e of g) if (e.key && liveMap.has(e.key) && !seen.has(e.key)) { seen.add(e.key); items.push(liveMap.get(e.key)!) }
    if (items.length) {
      const list = listName.get(e0.list_id) ?? 'Λίστα'
      report.push(`add→${await send(admin, to(e0), { title: `${list}: +${items.length}`, body: `${who(e0)} πρόσθεσε: ${names(items)}`, url: url(e0), tag: `add-${e0.list_id}` })}`)
    }
    done.push(...g.map(e => e.id))
  }
  if (done.length) await admin.from('lst_events').update({ sent_at: new Date().toISOString() }).in('id', done)
  await admin.from('lst_events').delete().lt('at', new Date(Date.now() - 30 * 864e5).toISOString())
  return report
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
  let body: { action?: string; space?: string; endpoint?: string } = {}
  try { body = await req.json() } catch { /* */ }
  try {
    if (body.action === 'key') return json({ publicKey: (await keys(admin)).pub })
    if (body.action === 'run') return json({ sent: await run(admin) })
    if (body.action === 'test') {
      const { data } = await admin.from('lst_subs').select('*').eq('space', body.space ?? '').eq('endpoint', body.endpoint ?? '')
      if (!data?.length) return json({ error: 'Η συσκευή δεν είναι γραμμένη.' }, 404)
      await vapid(admin)
      const n = await send(admin, data as Sub[], { title: 'Λίστες ✓', body: 'Οι ειδοποιήσεις φτάνουν σε αυτή τη συσκευή.', url: `${APP}?k=${encodeURIComponent(body.space ?? '')}`, tag: 'test' })
      return json({ sent: n })
    }
    return json({ error: 'Άγνωστη ενέργεια.' }, 400)
  } catch (e) {
    console.error(e)
    await admin.from('lst_errors').insert({ space: body.space ?? null, where_: 'lst-push', msg: String((e as Error).message ?? e).slice(0, 500) })
    return json({ error: 'Σφάλμα' }, 500)
  }
})
