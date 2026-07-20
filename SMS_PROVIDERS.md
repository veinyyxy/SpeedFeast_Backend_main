# SMS providers

The verification route selects an SMS provider through `SMS_PROVIDER`.

## Demo

```env
SMS_PROVIDER=demo
```

The demo provider does not send a message. It prints the verification message to
the server terminal and is intended for local development only.

## Twilio

Use either a Twilio phone number:

```env
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=replace-with-your-auth-token
TWILIO_FROM_NUMBER=+12045550100
```

Or a Twilio Messaging Service:

```env
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=replace-with-your-auth-token
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

When both sender settings are present, `TWILIO_MESSAGING_SERVICE_SID` takes
priority. Restart the server after changing environment variables.

## Adding a provider

Implement `SmsProvider` and register the implementation in
`sms_provider_factory.ts`. The verification route does not need to change.
