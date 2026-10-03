{{/* Image reference: <registry>/<name>:<tag>; registry and tag are required. */}}
{{- define "wizard.image" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{- $reg := required "images.registry is required (tofu output registry_url)" $root.Values.images.registry -}}
{{- $tag := required "images.tag is required (git sha)" $root.Values.images.tag -}}
{{- printf "%s/%s:%s" $reg $name $tag -}}
{{- end -}}

{{- define "wizard.labels" -}}
app.kubernetes.io/part-of: wizard
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
wizard.ru/env: {{ .Values.env }}
{{- end -}}

{{- define "wizard.selector" -}}
app.kubernetes.io/name: {{ . }}
{{- end -}}

{{/* Pod-level hardening (PodSecurity restricted, deploy.yaml#cloud.kubernetes.policies). */}}
{{- define "wizard.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: {{ . | default 1000 }}
  runAsGroup: {{ . | default 1000 }}
  fsGroup: {{ . | default 1000 }}
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "wizard.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  privileged: false
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{- define "wizard.imagePullSecrets" -}}
{{- if .Values.images.pullSecret }}
imagePullSecrets:
  - name: {{ .Values.images.pullSecret }}
{{- end }}
{{- end -}}

{{/* Non-secret env of the Node services (platform/deploy.yaml#local.env_vars). */}}
{{- define "wizard.commonEnv" -}}
- name: NODE_ENV
  value: production
- name: WIZARD_MILESTONE
  value: {{ .Values.config.milestone | quote }}
- name: WIZARD_PUBLIC_SCHEME
  value: https
- name: WIZARD_PLATFORM_ORIGIN
  value: {{ printf "https://%s" (required "domains.platform is required" .Values.domains.platform) | quote }}
- name: WIZARD_SYSTEMS_DOMAIN
  value: {{ required "domains.systems is required" .Values.domains.systems | quote }}
- name: WIZARD_LLM_MODE
  value: {{ .Values.config.llmMode | quote }}
- name: WIZARD_CONNECTORS
  value: {{ .Values.config.connectors | quote }}
- name: WIZARD_FILES_STORAGE
  value: {{ .Values.config.filesStorage | quote }}
- name: WIZARD_REGISTRATION
  value: {{ .Values.config.registration | quote }}
- name: WIZARD_PAYMENTS
  value: {{ .Values.config.payments | quote }}
- name: WIZARD_LLM_MONTHLY_CAP_RUB
  value: {{ .Values.config.llmMonthlyCapRub | quote }}
- name: WIZARD_FOUNDER_REVIEW
  value: {{ .Values.config.founderReview | quote }}
# M2-09: Prometheus /metrics listener (scraped through the pod annotations of wizard.metricsAnnotations).
- name: WIZARD_METRICS_PORT
  value: {{ .Values.metrics.port | quote }}
- name: WIZARD_METRICS_HOST
  value: "0.0.0.0"
{{- if .Values.config.s3Endpoint }}
- name: WIZARD_S3_ENDPOINT
  value: {{ .Values.config.s3Endpoint | quote }}
- name: WIZARD_S3_REGION
  value: {{ .Values.config.s3Region | quote }}
{{- end }}
# L3-27: X-Forwarded-For is believed only from the ingress pods (pod CIDR; NetworkPolicy lets only the ingress
# namespace reach the public ports).
- name: WIZARD_TRUSTED_PROXIES
  value: {{ .Values.network.podCidr | quote }}
- name: WIZARD_RUNTIME_INTERNAL_URL
  value: {{ printf "http://wizard-runtime-internal.%s.svc:%v" .Values.namespaces.platform .Values.runtime.internalPort | quote }}
- name: WIZARD_VERSION
  value: {{ .Values.images.tag | quote }}
- name: HOST
  value: "0.0.0.0"
{{- end -}}

{{/* Founder alert webhook of platform-api and worker (LLM cap of the month, M2-15): the same optional keys as pg-ops. */}}
{{- define "wizard.alertEnv" -}}
- name: WIZARD_OPS_ALERT_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.postgres }}, key: WIZARD_OPS_ALERT_URL, optional: true } }
- name: WIZARD_OPS_ALERT_CHAT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.postgres }}, key: WIZARD_OPS_ALERT_CHAT_ID, optional: true } }
- name: WIZARD_OPS_ALERT_EMAIL
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.postgres }}, key: WIZARD_OPS_ALERT_EMAIL, optional: true } }
{{- end -}}

{{/* M2-09: VictoriaMetrics scrapes annotated pods (addons/victoria-metrics-values.yaml) on the metrics port. */}}
{{- define "wizard.metricsAnnotations" -}}
prometheus.io/scrape: "true"
prometheus.io/port: {{ .Values.metrics.port | quote }}
prometheus.io/path: /metrics
{{- end -}}

{{/* Writable paths of a read-only root filesystem: /tmp (tsx cache) and the shared .data volume. */}}
{{- define "wizard.nodeVolumes" -}}
- name: tmp
  emptyDir: { sizeLimit: 256Mi }
- name: data
  persistentVolumeClaim:
    claimName: wizard-data
{{- end -}}

{{- define "wizard.nodeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: data
  mountPath: /app/.data
{{- end -}}

{{/* HSTS middleware reference for Traefik ingresses. */}}
{{- define "wizard.middlewares" -}}
{{ .Values.namespaces.platform }}-wizard-hsts@kubernetescrd
{{- end -}}

{{/* WAL-G of the self-managed PostgreSQL (postgres.inCluster): S3 of the provider, client-side libsodium encryption
     (key in the Secret), never overwrite an archived segment (a fresh cluster next to an old archive fails loudly). */}}
{{- define "wizard.walgEnv" -}}
- name: PGDATA
  value: /var/lib/postgresql/data/pgdata
- name: WALG_S3_PREFIX
  value: {{ printf "s3://%s/pg" (required "postgres.backupsBucket is required" .Values.postgres.backupsBucket) | quote }}
- name: AWS_ENDPOINT
  value: {{ required "config.s3Endpoint is required for WAL-G" .Values.config.s3Endpoint | quote }}
- name: AWS_REGION
  value: {{ .Values.config.s3Region | quote }}
- name: AWS_S3_FORCE_PATH_STYLE
  value: "true"
- name: WALG_LIBSODIUM_KEY_TRANSFORM
  value: hex
- name: WALG_COMPRESSION_METHOD
  value: {{ .Values.postgres.walg.compression | quote }}
- name: WALG_UPLOAD_CONCURRENCY
  value: {{ .Values.postgres.walg.uploadConcurrency | quote }}
- name: WALG_PREVENT_WAL_OVERWRITE
  value: "true"
{{- end -}}

{{/* Thresholds and alert channel of infra/postgres/pg-ops.mjs (structured log + optional webhook). */}}
{{- define "wizard.opsEnv" -}}
- name: WIZARD_ENV
  value: {{ .Values.env | quote }}
- name: PGUSER
  value: {{ .Values.postgres.user | quote }}
- name: PGDATABASE
  value: {{ .Values.postgres.database | quote }}
- name: WIZARD_ARCHIVE_MAX_LAG_SEC
  value: {{ .Values.postgres.maxArchiveLagSec | quote }}
- name: WIZARD_BACKUP_MAX_AGE_H
  value: {{ .Values.postgres.backup.maxAgeHours | quote }}
- name: WIZARD_BACKUP_RETENTION_DAYS
  value: {{ .Values.postgres.backup.retentionDays | quote }}
- name: WIZARD_DRILL_MAX_AGE_H
  value: {{ .Values.postgres.drill.maxAgeHours | quote }}
- name: WIZARD_OPS_ALERT_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.postgres }}, key: WIZARD_OPS_ALERT_URL, optional: true } }
- name: WIZARD_OPS_ALERT_CHAT_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.postgres }}, key: WIZARD_OPS_ALERT_CHAT_ID, optional: true } }
{{- end -}}

{{/* Jobs reach the database over its Service (password from the Secret). */}}
{{- define "wizard.pgTcpEnv" -}}
- name: PGHOST
  value: {{ printf "wizard-postgres.%s.svc" .Values.namespaces.platform | quote }}
- name: PGPORT
  value: {{ .Values.postgres.port | quote }}
- name: PGPASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.postgres }}, key: POSTGRES_PASSWORD } }
{{- end -}}

{{/* rclone remotes of the .data copy: s3 (keys from AWS_* of the Secret) and enc (crypt over s3:<bucket>/data). */}}
{{- define "wizard.rcloneEnv" -}}
{{ include "wizard.opsEnv" . }}
- name: WIZARD_PG_OPS_INTERVAL_SEC
  value: {{ .Values.dataBackup.intervalSec | quote }}
- name: RCLONE_CONFIG
  value: /tmp/rclone.conf
- name: RCLONE_CACHE_DIR
  value: /tmp/rclone
- name: RCLONE_CONFIG_S3_TYPE
  value: s3
- name: RCLONE_CONFIG_S3_PROVIDER
  value: Other
- name: RCLONE_CONFIG_S3_ENV_AUTH
  value: "true"
- name: RCLONE_CONFIG_S3_ENDPOINT
  value: {{ required "config.s3Endpoint is required for the .data copy" .Values.config.s3Endpoint | quote }}
- name: RCLONE_CONFIG_S3_REGION
  value: {{ .Values.config.s3Region | quote }}
- name: RCLONE_CONFIG_S3_FORCE_PATH_STYLE
  value: "true"
- name: RCLONE_CONFIG_S3_NO_CHECK_BUCKET
  value: "true"
- name: RCLONE_CONFIG_ENC_TYPE
  value: crypt
- name: RCLONE_CONFIG_ENC_REMOTE
  value: {{ printf "s3:%s/data" (required "postgres.backupsBucket is required" .Values.postgres.backupsBucket) | quote }}
{{- end -}}

{{/*
M2-18/M2-19: env of a sandbox orchestrator (apps/runtime/src/sandbox/from-env.ts) — (list $ <RPC port> <max pods>).
The pods have no DNS: they reach the orchestrating process on its pod IP.
*/}}
{{- define "wizard.sandboxEnv" -}}
{{- $ := index . 0 -}}
- name: WIZARD_SANDBOX
  value: k8s
- name: WIZARD_SANDBOX_NAMESPACE
  value: {{ $.Values.namespaces.sandbox | quote }}
- name: WIZARD_SANDBOX_IMAGE
  value: {{ include "wizard.image" (list $ $.Values.images.names.sandbox) | quote }}
- name: POD_IP
  valueFrom: { fieldRef: { fieldPath: status.podIP } }
- name: WIZARD_SANDBOX_RPC_ADDRESS
  value: {{ printf "$(POD_IP):%v" (index . 1) | quote }}
- name: WIZARD_SANDBOX_BASE_PORT
  value: {{ $.Values.sandbox.basePort | quote }}
- name: WIZARD_SANDBOX_HEALTH_PORT
  value: {{ $.Values.sandbox.healthPort | quote }}
- name: WIZARD_SANDBOX_SYSTEMS_PER_POD
  value: {{ $.Values.sandbox.systems | quote }}
- name: WIZARD_SANDBOX_MAX_PODS
  value: {{ index . 2 | quote }}
- name: WIZARD_SANDBOX_MEMORY
  value: {{ $.Values.sandbox.memoryLimit | quote }}
- name: WIZARD_SANDBOX_CPU
  value: {{ $.Values.sandbox.cpuLimit | quote }}
{{- end -}}
