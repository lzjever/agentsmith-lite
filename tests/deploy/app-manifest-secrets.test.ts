import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../packages/domain/src/sandboxDefaults.js";
import { renderAppManifests } from "../../packages/sandbox-controller/src/appManifestRenderer.js";

describe("app manifest rendering", () => {
  it("renders an Ingress from the public HTTPS URL with class, TLS, labels, and namespace", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        APP_PUBLIC_BASE_URL: "https://agentsmith.example.com/app",
        APP_INGRESS_CLASS: "nginx",
        APP_TLS_SECRET_NAME: "agentsmith-lite-tls"
      },
      secrets: {}
    });

    const ingress = manifests.find((manifest) => manifest.kind === "Ingress" && manifest.metadata.name === "agentsmith-lite-api") as
      | IngressResource
      | undefined;

    assert.ok(ingress, "app Ingress should be rendered for non-local public HTTPS URLs");
    assert.equal(ingress.apiVersion, "networking.k8s.io/v1");
    assert.equal(ingress.metadata.namespace, "agentsmith");
    assert.equal(ingress.metadata.labels["app.kubernetes.io/name"], "agentsmith-lite");
    assert.equal(ingress.metadata.labels["app.kubernetes.io/part-of"], "agentsmith-lite");
    assert.equal(ingress.metadata.labels["app.kubernetes.io/managed-by"], "agentsmith-lite");
    assert.equal(ingress.metadata.labels["agentsmith-lite/managed-by"], "agentsmith-lite");
    assert.equal(ingress.metadata.labels["app.kubernetes.io/component"], "api");
    assert.equal(ingress.spec.ingressClassName, "nginx");
    assert.deepEqual(ingress.spec.tls, [{ hosts: ["agentsmith.example.com"], secretName: "agentsmith-lite-tls" }]);
    assert.deepEqual(ingress.spec.rules, [
      {
        host: "agentsmith.example.com",
        http: {
          paths: [
            {
              path: "/app",
              pathType: "Prefix",
              backend: {
                service: {
                  name: "agentsmith-lite-api",
                  port: {
                    name: "http"
                  }
                }
              }
            }
          ]
        }
      }
    ]);
  });

  it("omits optional Ingress fields when unset and skips local public URLs", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        APP_PUBLIC_BASE_URL: "https://agentsmith.example.com",
        APP_INGRESS_CLASS: "",
        APP_TLS_SECRET_NAME: ""
      },
      secrets: {}
    });
    const ingress = manifests.find((manifest) => manifest.kind === "Ingress" && manifest.metadata.name === "agentsmith-lite-api") as
      | IngressResource
      | undefined;

    assert.ok(ingress, "non-local public URL should render an Ingress");
    assert.equal(ingress.spec.rules[0]?.http.paths[0]?.path, "/");
    assert.equal(ingress.spec.ingressClassName, undefined);
    assert.equal(ingress.spec.tls, undefined);

    for (const publicUrl of [undefined, "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const localManifests = renderAppManifests({
        namespace: "agentsmith",
        imageTag: "dev",
        env: publicUrl === undefined ? {} : { APP_PUBLIC_BASE_URL: publicUrl },
        secrets: {}
      });

      assert.equal(
        localManifests.some((manifest) => manifest.kind === "Ingress"),
        false,
        `${publicUrl ?? "default public URL"} should not render an Ingress`
      );
    }
  });

  it("rejects non-http public base URLs", () => {
    assert.throws(
      () =>
        renderAppManifests({
          namespace: "agentsmith",
          imageTag: "dev",
          env: {
            APP_PUBLIC_BASE_URL: "ftp://agentsmith.example.com"
          },
          secrets: {}
        }),
      /APP_PUBLIC_BASE_URL must be an http or https URL/
    );
  });

  it("renders only app-owned secrets and leaves raw S3/JuiceFS credentials to the substrate", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        KUBE_NAMESPACE: "agentsmith",
        JUICEFS_PVC_NAME: "agentsmith-lite-files",
        APP_PUBLIC_BASE_URL: "https://agentsmith.example.com",
        AUTH_MODE: "oidc",
        OIDC_ISSUER_URL: "https://keycloak.example.test/realms/agentsmith",
        OIDC_BACKCHANNEL_BASE_URL: "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith",
        OIDC_CLIENT_ID: "agentsmith-lite",
        AGENTSMITH_LITE_SANDBOX_MODE: "live",
        AGENTSMITH_LITE_RUNTIME_TICK_MS: "1000",
        BOTIFIED_RUNNER_IMAGE: "registry.example.com/agentsmith-lite/botified-runner:2026.07",
        AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI: "https://models.example.com/v1",
        S3_ENDPOINT: "https://s3.example.com",
        S3_BUCKET: "agentsmith-lite-files",
        JUICEFS_SECRET_NAME: "agentsmith-lite-juicefs",
        KEYCLOAK_DB_DATABASE: "keycloak"
      },
      secrets: {
        POSTGRES_APP_URL: "postgresql://app:secret@db/app",
        APP_SESSION_SECRET: "app-session-secret-at-least-32-chars",
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
        OIDC_CLIENT_SECRET: "oidc-client-secret",
        AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: "sk-openai",
        S3_ACCESS_KEY: "raw-access",
        S3_SECRET_KEY: "raw-secret",
        JUICEFS_META_URL: "postgresql://juicefs:secret@db/juicefs",
        KEYCLOAK_DB_USER: "keycloak-db-user",
        KEYCLOAK_DB_PASSWORD: "keycloak-db-password",
        KEYCLOAK_ADMIN_USERNAME: "keycloak-admin",
        KEYCLOAK_ADMIN_PASSWORD: "keycloak-admin-password"
      }
    });

    const serialized = JSON.stringify(manifests);
    assert.match(serialized, /AUTH_MODE/);
    assert.match(serialized, /OIDC_ISSUER_URL/);
    assert.match(serialized, /OIDC_BACKCHANNEL_BASE_URL/);
    assert.match(serialized, /OIDC_CLIENT_ID/);
    assert.match(serialized, /OIDC_CLIENT_SECRET/);
    assert.match(serialized, /POSTGRES_APP_URL/);
    assert.match(serialized, /APP_SESSION_SECRET/);
    assert.doesNotMatch(serialized, /BUILTIN_ADMIN_INITIAL_PASSWORD/);
    assert.match(serialized, /AGENTSMITH_LITE_MODEL_API_KEY_OPENAI/);
    assert.match(serialized, /sk-openai/);
    assert.match(serialized, /AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI/);
    assert.match(serialized, /https:\/\/models\.example\.com\/v1/);
    assert.doesNotMatch(serialized, /S3_ACCESS_KEY/);
    assert.doesNotMatch(serialized, /S3_SECRET_KEY/);
    assert.doesNotMatch(serialized, /JUICEFS_META_URL/);
    assert.doesNotMatch(serialized, /raw-access/);
    assert.doesNotMatch(serialized, /raw-secret/);
    assert.doesNotMatch(serialized, /KEYCLOAK_/);
    assert.doesNotMatch(serialized, /keycloak-db-user/);
    assert.doesNotMatch(serialized, /keycloak-db-password/);
    assert.doesNotMatch(serialized, /keycloak-admin/);
    assert.doesNotMatch(serialized, /keycloak-admin-password/);

    const configMap = manifests.find((manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config");
    const secret = manifests.find((manifest) => manifest.kind === "Secret" && manifest.metadata.name === "agentsmith-lite-app-secrets");
    const configMapData = (configMap as { data?: Record<string, string> } | undefined)?.data;
    const secretData = (secret as { stringData?: Record<string, string> } | undefined)?.stringData;
    assert.equal(configMapData?.AUTH_MODE, "oidc");
    assert.equal(configMapData?.OIDC_ISSUER_URL, "https://keycloak.example.test/realms/agentsmith");
    assert.equal(configMapData?.OIDC_BACKCHANNEL_BASE_URL, "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith");
    assert.equal(configMapData?.OIDC_CLIENT_ID, "agentsmith-lite");
    assert.equal(configMapData?.OIDC_CLIENT_SECRET, undefined);
    assert.equal(secretData?.OIDC_CLIENT_SECRET, "oidc-client-secret");
    assert.equal(secretData?.BUILTIN_ADMIN_INITIAL_PASSWORD, undefined);
    assert.equal(secretData?.OIDC_ISSUER_URL, undefined);
    assert.equal(secretData?.OIDC_BACKCHANNEL_BASE_URL, undefined);
    assert.equal(secretData?.OIDC_CLIENT_ID, undefined);
    assert.equal(configMapData?.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI, "https://models.example.com/v1");
    assert.equal(configMapData?.AGENTSMITH_LITE_SANDBOX_MODE, "live");
    assert.equal(configMapData?.AGENTSMITH_LITE_RUNTIME_TICK_MS, "1000");
    assert.equal(configMapData?.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT, String(DEFAULT_SANDBOX_NAMESPACE_LIMIT));
    assert.equal(configMapData?.BOTIFIED_RUNNER_IMAGE, "registry.example.com/agentsmith-lite/botified-runner:2026.07");
    assert.equal(secretData?.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI, "sk-openai");
    assert.equal(secretData?.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI, undefined);
  });

  it("mounts an optional model CA ConfigMap into the API pod without embedding raw PEM config", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP: "local-model-ca",
        AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY: "provider-ca.pem",
        AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI: "https://models.local.test/v1"
      },
      secrets: {
        AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: "sk-openai"
      }
    });

    const configMap = manifests.find((manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config");
    const configMapData = (configMap as { data?: Record<string, string> } | undefined)?.data;
    assert.equal(configMapData?.AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP, "local-model-ca");
    assert.equal(configMapData?.AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY, "provider-ca.pem");
    assert.equal(configMapData?.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(configMapData?.ca, undefined);
    assert.equal(configMapData?.["ca.crt"], undefined);
    assert.doesNotMatch(JSON.stringify(configMapData), /BEGIN CERTIFICATE/);

    const secret = manifests.find((manifest) => manifest.kind === "Secret" && manifest.metadata.name === "agentsmith-lite-app-secrets");
    const secretData = (secret as { stringData?: Record<string, string> } | undefined)?.stringData;
    assert.equal(secretData?.AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP, undefined);
    assert.equal(secretData?.AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY, undefined);

    const deployment = manifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.metadata.name === "agentsmith-lite-api"
    ) as DeploymentResource | undefined;
    const podSpec = deployment?.spec.template.spec;
    const container = podSpec?.containers[0];
    assert.ok(container);
    assert.deepEqual(container.env, [
      {
        name: "NODE_EXTRA_CA_CERTS",
        value: "/etc/agentsmith-lite/model-ca/ca.crt"
      }
    ]);
    assert.ok(
      container.volumeMounts.some(
        (mount) => mount.name === "model-ca" && mount.mountPath === "/etc/agentsmith-lite/model-ca/ca.crt" && mount.subPath === "ca.crt" && mount.readOnly === true
      )
    );
    assert.ok(
      podSpec?.volumes.some(
        (volume) =>
          volume.name === "model-ca" &&
          volume.configMap?.name === "local-model-ca" &&
          volume.configMap.items?.[0]?.key === "provider-ca.pem" &&
          volume.configMap.items?.[0]?.path === "ca.crt"
      )
    );
  });

  it("fails closed when OIDC keys are misplaced or incomplete without leaking values", () => {
    const cases: Array<{
      name: string;
      env: Record<string, string>;
      secrets: Record<string, string>;
      error: RegExp;
      leakedValue: RegExp;
    }> = [
      {
        name: "invalid auth mode",
        env: { AUTH_MODE: "DO_NOT_PRINT_AUTH_MODE" },
        secrets: {},
        error: /AUTH_MODE/,
        leakedValue: /DO_NOT_PRINT_AUTH_MODE/
      },
      {
        name: "OIDC secret in config",
        env: { OIDC_CLIENT_SECRET: "DO_NOT_PRINT_OIDC_CLIENT_SECRET" },
        secrets: {},
        error: /OIDC_CLIENT_SECRET/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_SECRET/
      },
      {
        name: "OIDC public metadata in secrets",
        env: {},
        secrets: { OIDC_ISSUER_URL: "DO_NOT_PRINT_OIDC_ISSUER_URL" },
        error: /OIDC_ISSUER_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_ISSUER_URL/
      },
      {
        name: "OIDC backchannel metadata in secrets",
        env: {},
        secrets: { OIDC_BACKCHANNEL_BASE_URL: "DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL" },
        error: /OIDC_BACKCHANNEL_BASE_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL/
      },
      {
        name: "OIDC mode missing secret",
        env: {
          AUTH_MODE: "oidc",
          OIDC_ISSUER_URL: "https://keycloak.example.test/realms/agentsmith",
          OIDC_CLIENT_ID: "DO_NOT_PRINT_OIDC_CLIENT_ID"
        },
        secrets: {},
        error: /OIDC_CLIENT_SECRET/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_ID/
      },
      {
        name: "builtin mode with non-empty OIDC metadata",
        env: {
          AUTH_MODE: "builtin_admin",
          OIDC_ISSUER_URL: "DO_NOT_PRINT_OIDC_ISSUER_URL"
        },
        secrets: {},
        error: /OIDC_ISSUER_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_ISSUER_URL/
      },
      {
        name: "builtin mode with non-empty OIDC backchannel metadata",
        env: {
          AUTH_MODE: "builtin_admin",
          OIDC_BACKCHANNEL_BASE_URL: "DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL"
        },
        secrets: {},
        error: /OIDC_BACKCHANNEL_BASE_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL/
      }
    ];

    for (const candidate of cases) {
      assert.throws(
        () =>
          renderAppManifests({
            namespace: "agentsmith",
            imageTag: "dev",
            env: candidate.env,
            secrets: candidate.secrets
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error, candidate.name);
          assert.match(error.message, candidate.error, candidate.name);
          assert.doesNotMatch(error.message, candidate.leakedValue, candidate.name);
          return true;
        },
        candidate.name
      );
    }
  });

  it("defaults the API data root to the PVC mount root while allowing env override", () => {
    const defaultManifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {},
      secrets: {}
    });
    const defaultConfigMap = defaultManifests.find(
      (manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config"
    );
    const defaultDeployment = defaultManifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.metadata.name === "agentsmith-lite-api"
    ) as DeploymentResource | undefined;
    const defaultConfigMapData = (defaultConfigMap as { data?: Record<string, string> } | undefined)?.data;
    const defaultMountPath = defaultDeployment?.spec.template.spec.containers[0]?.volumeMounts[0]?.mountPath;

    assert.equal(defaultConfigMapData?.AGENTSMITH_LITE_DATA_DIR, "/agentsmith-lite");
    assert.equal(defaultMountPath, "/agentsmith-lite");

    const overrideManifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        AGENTSMITH_LITE_DATA_DIR: "/custom-data-root"
      },
      secrets: {}
    });
    const overrideConfigMap = overrideManifests.find(
      (manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config"
    );
    const overrideDeployment = overrideManifests.find(
      (manifest) => manifest.kind === "Deployment" && manifest.metadata.name === "agentsmith-lite-api"
    ) as DeploymentResource | undefined;
    const overrideConfigMapData = (overrideConfigMap as { data?: Record<string, string> } | undefined)?.data;
    const overrideMountPath = overrideDeployment?.spec.template.spec.containers[0]?.volumeMounts[0]?.mountPath;

    assert.equal(overrideConfigMapData?.AGENTSMITH_LITE_DATA_DIR, "/custom-data-root");
    assert.equal(overrideMountPath, "/custom-data-root");
  });

  it("rejects relative API data roots before rendering Kubernetes env or mounts", () => {
    assert.throws(
      () =>
        renderAppManifests({
          namespace: "agentsmith",
          imageTag: "dev",
          env: {
            AGENTSMITH_LITE_DATA_DIR: "relative-data-root"
          },
          secrets: {}
        }),
      /AGENTSMITH_LITE_DATA_DIR must be an absolute path/
    );
  });

  it("renders the namespace sandbox limit default and operator override", () => {
    const defaultManifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {},
      secrets: {}
    });
    const defaultConfigMap = defaultManifests.find(
      (manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config"
    );
    const defaultConfigMapData = (defaultConfigMap as { data?: Record<string, string> } | undefined)?.data;
    assert.equal(defaultConfigMapData?.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT, String(DEFAULT_SANDBOX_NAMESPACE_LIMIT));

    const overrideManifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT: "7"
      },
      secrets: {}
    });
    const overrideConfigMap = overrideManifests.find(
      (manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config"
    );
    const overrideConfigMapData = (overrideConfigMap as { data?: Record<string, string> } | undefined)?.data;
    assert.equal(overrideConfigMapData?.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT, "7");
  });

  it("grants the API only namespace-scoped sandbox lifecycle resources", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {},
      secrets: {}
    });
    const role = manifests.find((manifest) => manifest.kind === "Role" && manifest.metadata.name === "agentsmith-lite-api-sandbox") as
      | RoleResource
      | undefined;

    assert.ok(role, "API sandbox Role should be rendered");
    const configMap = manifests.find((manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config");
    const configMapData = (configMap as { data?: Record<string, string> } | undefined)?.data;
    assert.equal(configMapData?.AGENTSMITH_LITE_SANDBOX_MODE, "dry-run");
    assert.equal(configMapData?.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT, String(DEFAULT_SANDBOX_NAMESPACE_LIMIT));
    assert.equal(configMapData?.AGENTSMITH_LITE_RUNTIME_TICK_MS, undefined);
    assert.equal(configMapData?.BOTIFIED_RUNNER_IMAGE, "agentsmith-lite/botified-runner:dev");
    assert.equal(configMapData?.AUTH_MODE, undefined);
    assert.ok(
      role.rules.some(
        (rule) =>
          rule.apiGroups.length === 1 &&
          rule.apiGroups[0] === "" &&
          ["pods", "services", "secrets", "configmaps", "serviceaccounts"].every((resource) => rule.resources.includes(resource))
      )
    );
    assert.ok(
      role.rules.some(
        (rule) =>
          rule.apiGroups.includes("networking.k8s.io") &&
          rule.resources.includes("networkpolicies") &&
          ["create", "get", "list", "delete", "patch"].every((verb) => rule.verbs.includes(verb))
      )
    );

    const resources = role.rules.flatMap((rule) => rule.resources);
    const verbs = role.rules.flatMap((rule) => rule.verbs);
    assert.equal(verbs.includes("watch"), false, "API sandbox Role should not grant watch");
    for (const forbidden of [
      "pods/exec",
      "pods/log",
      "pods/attach",
      "pods/portforward",
      "persistentvolumes",
      "persistentvolumeclaims",
      "storageclasses",
      "nodes",
      "namespaces",
      "clusterroles",
      "clusterrolebindings"
    ]) {
      assert.equal(resources.includes(forbidden), false, `${forbidden} must not be granted`);
    }
  });

  it("keeps the deploy doctor aligned with forbidden sandbox RBAC resources", () => {
    const doctor = readFileSync("scripts/deploy/doctor.sh", "utf8");

    for (const forbidden of ["watch", "--subresource=exec", "persistentvolumes", "persistentvolumeclaims"]) {
      assert.match(doctor, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("renders a fixed schema bootstrap Job with bounded retries and only app-owned secrets", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {},
      secrets: {
        POSTGRES_APP_URL: "postgresql://app:secret@db/app",
        APP_SESSION_SECRET: "app-session-secret-at-least-32-chars",
        S3_SECRET_KEY: "raw-secret"
      }
    });
    const job = manifests.find((manifest) => manifest.kind === "Job" && manifest.metadata.name === "agentsmith-lite-schema-bootstrap") as
      | JobResource
      | undefined;

    assert.ok(job, "fixed schema bootstrap Job should be rendered for delete-before-apply readiness");
    assert.equal(job.metadata.namespace, "agentsmith");
    assert.equal(job.spec.backoffLimit, 2);
    assert.equal(job.spec.activeDeadlineSeconds, 300);
    assert.equal(job.spec.ttlSecondsAfterFinished, 600);
    assert.equal(job.spec.template.spec.restartPolicy, "OnFailure");

    const container = job.spec.template.spec.containers.find((candidate) => candidate.name === "schema-bootstrap");
    assert.ok(container, "schema bootstrap container should be rendered");
    assert.deepEqual(container.envFrom, [{ secretRef: { name: "agentsmith-lite-app-secrets" } }]);

    const serializedJob = JSON.stringify(job);
    assert.match(serializedJob, /agentsmith-lite-app-secrets/);
    assert.doesNotMatch(serializedJob, /S3_SECRET_KEY/);
    assert.doesNotMatch(serializedJob, /raw-secret/);
  });
});

interface RoleResource {
  kind: "Role";
  metadata: {
    name: string;
  };
  rules: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
}

interface JobResource {
  kind: "Job";
  metadata: {
    name: string;
    namespace?: string;
  };
  spec: {
    backoffLimit: number;
    activeDeadlineSeconds: number;
    ttlSecondsAfterFinished: number;
    template: {
      spec: {
        restartPolicy: string;
        containers: Array<{
          name: string;
          envFrom?: Array<{
            secretRef: {
              name: string;
            };
          }>;
        }>;
      };
    };
  };
}

interface DeploymentResource {
  kind: "Deployment";
  metadata: {
    name: string;
    namespace?: string;
    labels: Record<string, string>;
  };
  spec: {
    template: {
      spec: {
        containers: Array<{
          env?: Array<{ name: string; value: string }>;
          volumeMounts: Array<{ name?: string; mountPath: string; subPath?: string; readOnly?: boolean }>;
        }>;
        volumes: Array<{
          name: string;
          configMap?: {
            name: string;
            items?: Array<{ key: string; path: string }>;
          };
        }>;
      };
    };
  };
}

interface IngressResource {
  apiVersion: string;
  kind: "Ingress";
  metadata: {
    name: string;
    namespace?: string;
    labels: Record<string, string>;
  };
  spec: {
    ingressClassName?: string;
    tls?: Array<{
      hosts: string[];
      secretName: string;
    }>;
    rules: Array<{
      host: string;
      http: {
        paths: Array<{
          path: string;
          pathType: string;
          backend: {
            service: {
              name: string;
              port: {
                name?: string;
                number?: number;
              };
            };
          };
        }>;
      };
    }>;
  };
}
