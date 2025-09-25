export interface verificationInfoSender {
    sendInformation(to: string, subject: string, body: string): Promise<void>;
}
