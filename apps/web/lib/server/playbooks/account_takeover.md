# Playbook: account_takeover — "Someone signed in to my account"

Use when a sign-in alert says someone signed in (or changed the password, recovery options or 2-step verification) and the person says it was not them, or when they think someone else is in an account. Ask which account it is and whether they can still sign in. Never ask for their password, a code or a recovery key, and do not use any link in the alert.

## First, right now
1. From a device you know is clean, go to the real site or app yourself (type the address or open the app, not the link in the email) and change the password to a new, unique one. If you cannot sign in, use the provider's "Forgot password" recovery from that same trusted device.
2. Sign out all other sessions: look for "Sign out of all devices" or "Where you're signed in" in the account's security settings.
3. Review the recovery email, phone number and 2-step verification. Remove anything you did not add, then turn on 2-step verification with an authenticator app or a passkey.
4. If the same password is used anywhere else, change it there too, starting with your email and banking.

## Then
- Check for forwarding rules, filters and connected apps that quietly copy your mail. Attackers add these so they keep seeing your messages after the password changes.
  - Google: Security Checkup at https://myaccount.google.com/security-checkup, and Gmail Settings → Forwarding and filters.
  - Microsoft: recent activity at https://account.live.com/Activity, then Outlook Settings → Mail → Forwarding and Rules.
  - Apple: review signed-in devices and trusted phone numbers at https://account.apple.com.
- Check recent activity on the account (sign-ins, orders, payments, sent messages) and note anything you do not recognize.
- Remove devices, app passwords and third-party connections you do not recognize.
- If a payment method is saved there, look at recent charges and tell your bank or card issuer about anything unfamiliar, using the number on the back of your card.
- If this was your email account, password-reset emails for your other accounts may have been read: change those passwords too, starting with the most important.

## Report
- Use the provider's "Report" or "My account was hacked" help page, reached from the official site or app.
- Phishing email: "Report phishing" in Gmail or Outlook; Apple-themed scams to reportphishing@apple.com.
- If money or identity is involved: https://reportfraud.ftc.gov (US), or IC3 at https://www.ic3.gov for internet crime. Outside the US, their country's consumer protection agency.

## What to watch for next
- Password-reset emails or sign-in alerts you did not ask for, from any account. Check them inside the real app, not through the email.
- Messages sent from your account to your contacts asking for money or codes: warn friends and family.
- Anyone calling or texting to "help recover" the account: that is usually the next step of the same scam.

## Reassurance
Most account takeovers are stopped by a new password and signing out other sessions. If you did these steps quickly, the person who got in is locked out, and the remaining work is making sure they left nothing behind.
