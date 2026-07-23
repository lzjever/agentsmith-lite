import { TextInput } from "@astryxdesign/core";

export function CredentialSecretField({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <TextInput label="API key" htmlName="secret" type="password" value={value} onChange={onChange} isRequired isDisabled={disabled} width="100%" />;
}
