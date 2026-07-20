import { verificationInfoSender } from '../interface_verification_sender';
import { createSmsProvider } from './sms_provider_factory';
import { SmsProvider } from './sms_provider';

export class SMSender implements verificationInfoSender {
    private readonly provider: SmsProvider;

    constructor(provider: SmsProvider = createSmsProvider()) {
        this.provider = provider;
    }

    async sendInformation(to: string, subject: string, body: string): Promise<void> {
        await this.provider.send({ to, body });
    }
}
