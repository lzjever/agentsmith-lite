import * as oidc from "openid-client";
import type { ExternalPrincipal } from "../../application/src/authService.js";

export interface OidcAuthorizationRequestInput {
  redirectUri: string;
}

export interface OidcAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface OidcCallbackInput {
  callbackUrl: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  nonce?: string | undefined;
}

export interface OidcClientAdapter {
  createAuthorizationRequest(input: OidcAuthorizationRequestInput): Promise<OidcAuthorizationRequest>;
  completeAuthorizationCallback(input: OidcCallbackInput): Promise<ExternalPrincipal>;
}

export interface CreateOpenIdConnectClientInput {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

export async function createOpenIdConnectClient(input: CreateOpenIdConnectClientInput): Promise<OidcClientAdapter> {
  const config = await oidc.discovery(new URL(input.issuerUrl), input.clientId, input.clientSecret);
  return new OpenIdConnectClient(config, input.issuerUrl);
}

class OpenIdConnectClient implements OidcClientAdapter {
  constructor(
    private readonly config: oidc.Configuration,
    private readonly issuerUrl: string
  ) {}

  async createAuthorizationRequest(input: OidcAuthorizationRequestInput): Promise<OidcAuthorizationRequest> {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const authorizationUrl = oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: input.redirectUri,
      scope: "openid email profile",
      response_type: "code",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
      codeVerifier,
      nonce
    };
  }

  async completeAuthorizationCallback(input: OidcCallbackInput): Promise<ExternalPrincipal> {
    const tokens = await oidc.authorizationCodeGrant(this.config, new URL(input.callbackUrl), {
      expectedState: input.state,
      idTokenExpected: true,
      pkceCodeVerifier: input.codeVerifier,
      ...(input.nonce ? { expectedNonce: input.nonce } : {})
    });
    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error("OIDC ID token subject is required");
    }
    return {
      issuer: issuerFromClaims(claims.iss) ?? this.issuerUrl,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined
    };
  }
}

function issuerFromClaims(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
