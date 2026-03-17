export interface AptosAccountResource {
  type: string;
  data: {
    coin?: { value: string };
    sequence_number?: string;
    [key: string]: unknown;
  };
}

export interface AptosTransaction {
  version: string;
  hash: string;
  sequence_number: string;
  timestamp: string; // microseconds as string
  gas_used: string;
  gas_unit_price: string;
  success: boolean;
  type: string;
}

export interface AptosAccountInfo {
  sequence_number: string;
  authentication_key: string;
}

export interface ApiError {
  message: string;
  error_code: string;
  vm_error_code?: number;
}
