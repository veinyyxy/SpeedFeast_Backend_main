import { SmsMessage, SmsProvider, SmsSendResult } from './sms_provider';

function maskPhoneNumber(phoneNumber: string): string {
    if (phoneNumber.length <= 4) {
        return phoneNumber;
    }

    return `${phoneNumber.slice(0, 3)}***${phoneNumber.slice(-4)}`;
}

export class DemoSmsProvider implements SmsProvider {
    readonly name = 'demo';

    async send(message: SmsMessage): Promise<SmsSendResult> {
        console.log(`[SMS:demo] To ${maskPhoneNumber(message.to)}: ${message.body}`);

        return {
            provider: this.name,
            status: 'displayed',
        };
    }
}
