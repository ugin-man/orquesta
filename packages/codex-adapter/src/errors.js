const ADAPTER_FAILURE_STATUSES = Object.freeze([
  "unsupported",
  "unauthorized",
  "unavailable",
  "rejected",
  "failed"
]);

class AdapterContractError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "AdapterContractError";
  }
}

module.exports = {
  ADAPTER_FAILURE_STATUSES,
  AdapterContractError
};
