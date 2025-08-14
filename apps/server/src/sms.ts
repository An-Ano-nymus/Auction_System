import twilio from 'twilio'

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN
const TWILIO_FROM = process.env.TWILIO_FROM

let client: ReturnType<typeof twilio> | null = null
function getClient() {
  if (client) return client
  if (!TWILIO_SID || !TWILIO_TOKEN) return null
  client = twilio(TWILIO_SID, TWILIO_TOKEN)
  return client
}

export async function sendSms(to: string, body: string) {
  const c = getClient()
  if (!c || !TWILIO_FROM) return { skipped: true }
  await c.messages.create({ to, from: TWILIO_FROM, body })
  return { ok: true }
}
