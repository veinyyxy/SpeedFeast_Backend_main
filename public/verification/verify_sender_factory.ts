import { verificationInfoSender } from './interface_verification_sender';
import { GmailSender } from './wrap_email_sender/implement_email_sender';
import { SMSender } from './warp_sms_sender/implement_SMS_sender';
// import { OtherSender } from './otherSender';

export function createVerifySender(type: string): verificationInfoSender {
    if (type === 'email') {
        return new GmailSender();
    }
    else {
        return new SMSender();
    }
    
}