{{- define "t4-cluster.name" -}}
t4-cluster
{{- end -}}

{{- define "t4-cluster.fullname" -}}
{{- if contains "t4-cluster" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-t4-cluster" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "t4-cluster.suffixedName" -}}
{{- $suffix := .suffix -}}
{{- $maxBaseLength := sub 62 (len $suffix) | int -}}
{{- $base := include "t4-cluster.fullname" .context | trunc $maxBaseLength | trimSuffix "-" -}}
{{- printf "%s-%s" $base $suffix -}}
{{- end -}}

{{- define "t4-cluster.labels" -}}
app.kubernetes.io/name: {{ include "t4-cluster.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/part-of: "t4-cluster"
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}

{{- define "t4-cluster.selectorLabels" -}}
app.kubernetes.io/name: {{ include "t4-cluster.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{- define "t4-cluster.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}

{{- define "t4-cluster.validatePublicApi" -}}
{{- if .Values.publicApi.enabled -}}
{{- $existingSecret := required "publicApi.existingSecret is required when publicApi.enabled is true" .Values.publicApi.existingSecret -}}
{{- $postgresURLKey := required "publicApi.postgresURLKey is required when publicApi.enabled is true" .Values.publicApi.postgresURLKey -}}
{{- $credentialsKey := required "publicApi.credentialsKey is required when publicApi.enabled is true" .Values.publicApi.credentialsKey -}}
{{- if eq $postgresURLKey $credentialsKey -}}
{{- fail "publicApi.postgresURLKey and publicApi.credentialsKey must be different" -}}
{{- end -}}
{{- if not .Values.networkPolicy.enabled -}}
{{- fail "networkPolicy.enabled must be true when publicApi.enabled is true" -}}
{{- end -}}
{{- if empty .Values.networkPolicy.postgresPorts -}}
{{- fail "networkPolicy.postgresPorts must contain at least one port when publicApi.enabled is true" -}}
{{- end -}}
{{- $hasPostgresNamespaceSelector := not (empty .Values.networkPolicy.postgres.namespaceSelector) -}}
{{- $hasPostgresPodSelector := not (empty .Values.networkPolicy.postgres.podSelector) -}}
{{- if ne $hasPostgresNamespaceSelector $hasPostgresPodSelector -}}
{{- fail "networkPolicy.postgres namespaceSelector and podSelector must both be configured or both be empty" -}}
{{- end -}}
{{- if and (empty .Values.networkPolicy.postgresCIDRs) (not $hasPostgresNamespaceSelector) -}}
{{- fail "publicApi.enabled requires a PostgreSQL CIDR or complete selector destination" -}}
{{- end -}}
{{- end -}}
{{- end -}}
