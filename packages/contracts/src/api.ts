export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
  };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
