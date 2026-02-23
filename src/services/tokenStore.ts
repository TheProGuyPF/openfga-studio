import { config } from '../config';

let currentToken: string | null = null;

export function getApiToken(): string {
  return currentToken || config.apiToken;
}

export function setApiToken(token: string | null): void {
  currentToken = token;
}
