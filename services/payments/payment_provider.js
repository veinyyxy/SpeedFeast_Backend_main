class PaymentProvider {
  constructor(name) {
    this.name = name;
  }

  async createPayment() {
    throw new Error(`${this.name} createPayment is not implemented`);
  }

  resolvePaymentFlow() {
    return 'redirect';
  }

  async getPaymentStatus() {
    throw new Error(`${this.name} getPaymentStatus is not implemented`);
  }

  async refundPayment() {
    throw new Error(`${this.name} refundPayment is not implemented`);
  }

  async syncPaymentRecords() {
    throw new Error(`${this.name} syncPaymentRecords is not implemented`);
  }

  async handleWebhook() {
    throw new Error(`${this.name} handleWebhook is not implemented`);
  }
}

module.exports = PaymentProvider;
