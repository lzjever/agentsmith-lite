import { TextInput } from "@astryxdesign/core";

export function CredentialSecretField({ value, onChange, disabled = false, hasAutoFocus = false }: { value: string; onChange: (value: string) => void; disabled?: boolean; hasAutoFocus?: boolean }) {
  return <TextInput label="API key" htmlName="secret" type="password" value={value} onChange={onChange} isRequired isDisabled={disabled} hasAutoFocus={hasAutoFocus} data-autofocus={hasAutoFocus ? "" : undefined} width="100%" />;
}
