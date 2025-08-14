const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN
const TWILIO_FROM = process.env.TWILIO_FROM

export async function sendSms(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return { skipped: true }
  try {
    const twilio: any = (await import('twilio')).default
    const client = twilio(TWILIO_SID, TWILIO_TOKEN)
    await client.messages.create({ to, from: TWILIO_FROM, body })
    return { ok: true }
  } catch {
    return { skipped: true }
  }
}
