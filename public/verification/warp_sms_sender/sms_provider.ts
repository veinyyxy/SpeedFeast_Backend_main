export interface SmsMessage {
    to: string;
    body: string;
}

export interface SmsSendResult {
    provider: string;
    messageId?: string;
    status?: string;
}

export interface SmsProvider {
    readonly name: string;
    send(message: SmsMessage): Promise<SmsSendResult>;
}
