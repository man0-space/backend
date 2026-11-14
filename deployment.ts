import dotenv from 'dotenv';

export const backendSecret = 'backend-secrets';
export const backendEnvPath = '/var/run/secrets/backend/.env';
export const backendServiceAccount = '10047192908-compute@developer.gserviceaccount.com';

export function deploymentEnvironment(source: string) {
  const values = dotenv.parse(source);
  const project = values.GOOGLE_CLOUD_PROJECT_ID?.trim();
  if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error('GOOGLE_CLOUD_PROJECT_ID must be a valid project ID.');
  }
  return { project, values, payload: source };
}

export function cloudRunManifest(image: string, secretVersion: string): string {
  if (!/^europe-west1-docker\.pkg\.dev\/[a-z0-9-]+\/cloud-run-source-deploy\/api@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Invalid backend image digest.');
  }
  if (!/^[1-9][0-9]*$/.test(secretVersion)) {
    throw new Error('An explicit Secret Manager version is required.');
  }
  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: api
  labels:
    cloud.googleapis.com/location: europe-west1
  annotations:
    run.googleapis.com/ingress: all
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/maxScale: '100'
        run.googleapis.com/startup-cpu-boost: 'true'
    spec:
      containerConcurrency: 80
      timeoutSeconds: 300
      serviceAccountName: ${backendServiceAccount}
      containers:
        - image: ${image}
          ports:
            - name: http1
              containerPort: 8080
          resources:
            limits:
              cpu: 1000m
              memory: 512Mi
          startupProbe:
            timeoutSeconds: 240
            periodSeconds: 240
            failureThreshold: 1
            tcpSocket:
              port: 8080
          env:
            - name: DOTENV_CONFIG_PATH
              value: ${backendEnvPath}
          volumeMounts:
            - name: backend-env
              mountPath: /var/run/secrets/backend
      volumes:
        - name: backend-env
          secret:
            secretName: ${backendSecret}
            items:
              - key: '${secretVersion}'
                path: .env
  traffic:
    - percent: 100
      latestRevision: true
`;
}
