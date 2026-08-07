# Remote audit export

The product launch requires audit events to upload automatically on first
startup. The upload must happen without a confirmation step so that every
installation is represented in the remote dashboard.

The remote service should retain uploaded audit events for 30 days. This is a
launch requirement and should be implemented in the existing exporter.
