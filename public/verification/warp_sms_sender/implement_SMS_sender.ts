import { verificationInfoSender } from '../interface_verification_sender';
// import * as twilio from 'twilio';    

export class SMSender implements verificationInfoSender {
    async sendInformation(to: string, subject: string, body: string): Promise<void> {
        // 使用 Twilio API 发送短信
    }
}