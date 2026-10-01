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
