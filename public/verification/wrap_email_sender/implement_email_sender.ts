import { verificationInfoSender } from '../interface_verification_sender';
import * as  sgMail  from '@sendgrid/mail';

export class GmailSender implements verificationInfoSender {
    async sendInformation(to: string, subject: string, body: string): Promise<void> {

        // 设置你的 API Key（建议用环境变量管理）
        sgMail.setApiKey('');

        const msg = {
        to: to, // 收件人
        from: 'veinyyang@gmail.com', // 发件人（必须在 SendGrid 验证过）
        subject: subject,
        html: body,
        };

        sgMail.send(msg)
        .then(() => {
            console.log('✅ Email sent');
        })
        .catch((error) => {
            console.error('❌ Error sending email:', error);
        });
    }
}