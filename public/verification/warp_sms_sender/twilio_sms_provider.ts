import twilio = require('twilio');
import { SmsMessage, SmsProvider, SmsSendResult } from './sms_provider';

interface TwilioSmsConfig {
    accountSid: string;
    authToken: string;
    fromNumber?: string;
    messagingServiceSid?: string;
}

function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required when SMS_PROVIDER=twilio`);
    }

    return value;
}

function loadConfig(): TwilioSmsConfig {
    const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim();
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();

    if (!fromNumber && !messagingServiceSid) {
        throw new Error(
            'TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required when SMS_PROVIDER=twilio',
        );
    }

    return {
        accountSid: requiredEnvironmentVariable('TWILIO_ACCOUNT_SID'),
        authToken: requiredEnvironmentVariable('TWILIO_AUTH_TOKEN'),
        fromNumber,
        messagingServiceSid,
    };
}

export class TwilioSmsProvider implements SmsProvider {
    readonly name = 'twilio';

    private readonly client: twilio.Twilio;
    private readonly fromNumber?: string;
    private readonly messagingServiceSid?: string;

    constructor(config: TwilioSmsConfig = loadConfig()) {
        this.client = twilio(config.accountSid, config.authToken);
        this.fromNumber = config.fromNumber;
        this.messagingServiceSid = config.messagingServiceSid;
    }

    async send(message: SmsMessage): Promise<SmsSendResult> {
        const sender = this.messagingServiceSid
            ? { messagingServiceSid: this.messagingServiceSid }
            : { from: this.fromNumber as string };

        const result = await this.client.messages.create({
            body: message.body,
            to: message.to,
            ...sender,
        });

        console.log(`[SMS:twilio] Message ${result.sid} accepted with status ${result.status}`);

        return {
            provider: this.name,
            messageId: result.sid,
            status: result.status,
        };
    }
}
