// O que uma porta responde quando diz não. Cada uma corresponde a um status HTTP em http.ts.
export class InputError extends Error {}
export class AuthError extends Error {}
export class Conflict extends Error {}
export class NotFound extends Error {}
