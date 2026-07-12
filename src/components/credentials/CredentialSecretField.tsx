import { Input } from "../ui/input";

export function CredentialSecretField() { return <label className="grid gap-2 text-sm">API key<Input required name="secret" type="password" autoComplete="new-password" /></label>; }
