import { DemoSmsProvider } from './demo_sms_provider';
import { SmsProvider } from './sms_provider';
import { TwilioSmsProvider } from './twilio_sms_provider';

const DEFAULT_PROVIDER = 'demo';

export function createSmsProvider(providerName = process.env.SMS_PROVIDER): SmsProvider {
    const normalizedName = providerName?.trim().toLowerCase() || DEFAULT_PROVIDER;

    if (!providerName) {
        console.warn('[SMS] SMS_PROVIDER is not configured; using the demo provider.');
    }

    switch (normalizedName) {
        case 'demo':
            return new DemoSmsProvider();
        case 'twilio':
            return new TwilioSmsProvider();
        default:
            throw new Error(
                `Unsupported SMS_PROVIDER "${providerName}". Supported providers: demo, twilio`,
            );
    }
}
