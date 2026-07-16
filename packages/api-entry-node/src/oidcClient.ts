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

export interface OidcEndSessionInput {
  postLogoutRedirectUri: string;
}

export interface OidcClientAdapter {
  createAuthorizationRequest(input: OidcAuthorizationRequestInput): Promise<OidcAuthorizationRequest>;
  completeAuthorizationCallback(input: OidcCallbackInput): Promise<ExternalPrincipal>;
  createEndSessionUrl(input: OidcEndSessionInput): string;
}

export interface CreateOpenIdConnectClientInput {
  issuerUrl: string;
  backchannelBaseUrl?: string;
  clientId: string;
  clientSecret: string;
}

export async function createOpenIdConnectClient(input: CreateOpenIdConnectClientInput): Promise<OidcClientAdapter> {
  const discoveryOptions = createDiscoveryOptions(input.issuerUrl, input.backchannelBaseUrl);
  const config = await oidc.discovery(new URL(input.issuerUrl), input.clientId, input.clientSecret, undefined, discoveryOptions);
  return new OpenIdConnectClient(config, input.issuerUrl);
}

export function rewriteOidcBackchannelRequest(
  request: string | URL | Request,
  issuerUrl: string,
  backchannelBaseUrl: string
): string | Request {
  const originalUrl = request instanceof Request ? request.url : request.toString();
  const rewrittenUrl = rewriteOidcBackchannelUrl(originalUrl, issuerUrl, backchannelBaseUrl);
  if (!rewrittenUrl || rewrittenUrl === originalUrl) {
    return request instanceof Request ? request : originalUrl;
  }
  if (request instanceof Request) {
    return new Request(rewrittenUrl, request);
  }
  return rewrittenUrl;
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
      email: typeof claims.email === "string" ? claims.email : "",
      emailVerified: claims.email_verified === true,
      ...(typeof claims.picture === "string" && claims.picture.trim() ? { pictureUrl: claims.picture.trim() } : {})
    };
  }

  createEndSessionUrl(input: OidcEndSessionInput): string {
    return oidc.buildEndSessionUrl(this.config, {
      post_logout_redirect_uri: input.postLogoutRedirectUri
    }).toString();
  }
}

function issuerFromClaims(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createDiscoveryOptions(issuerUrl: string, backchannelBaseUrl: string | undefined): oidc.DiscoveryRequestOptions | undefined {
  const options: oidc.DiscoveryRequestOptions = {};
  let hasOptions = false;
  if (backchannelBaseUrl) {
    options[oidc.customFetch] = async (url, init) =>
      fetch(rewriteOidcBackchannelUrl(url, issuerUrl, backchannelBaseUrl) ?? url, toRequestInit(init));
    hasOptions = true;
  }
  if (usesHttp(issuerUrl) || (backchannelBaseUrl ? usesHttp(backchannelBaseUrl) : false)) {
    options.execute = [oidc.allowInsecureRequests];
    hasOptions = true;
  }
  return hasOptions ? options : undefined;
}

function rewriteOidcBackchannelUrl(url: string, issuerUrl: string, backchannelBaseUrl: string): string | undefined {
  const issuer = issuerUrl.replace(/\/$/, "");
  if (url !== issuer && !url.startsWith(`${issuer}/`) && !url.startsWith(`${issuer}?`)) {
    return undefined;
  }

  const backchannel = backchannelBaseUrl.replace(/\/$/, "");
  return `${backchannel}${url.slice(issuer.length)}`;
}

function usesHttp(url: string): boolean {
  return new URL(url).protocol === "http:";
}

function toRequestInit(init: oidc.CustomFetchOptions): RequestInit {
  return {
    method: init.method,
    headers: init.headers,
    redirect: init.redirect,
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.body === undefined ? {} : { body: init.body as BodyInit })
  };
}
