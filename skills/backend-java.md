# Skill: Backend Java 21 Spring Boot (Lane A — Render Free + GHCR)

Use this skill when building or containerizing a Java 21 Spring Boot service for deployment to Render Free (512 MB RAM) via GitHub Container Registry (`ghcr.io`).

## 1. Multi-Stage `Dockerfile` (Repo Root)

Always build `linux/amd64` images with a non-root runtime user and memory flags tuned for Render's 512 MB RAM ceiling:

```dockerfile
FROM --platform=linux/amd64 maven:3.9-eclipse-temurin-21-alpine AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B package -DskipTests

FROM --platform=linux/amd64 eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /build/target/*.jar /app/app.jar
RUN chown app:app /app/app.jar
USER app
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=65.0 -XX:+UseSerialGC -Xss256k -Djava.security.egd=file:/dev/./urandom"
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "exec java -Dserver.port=${PORT:-8080} -jar /app/app.jar"]
```

## 2. Root `render.yaml` Blueprint

```yaml
services:
  - type: web
    name: <repo-name>
    runtime: image
    plan: free
    image:
      url: ghcr.io/ankul01/<repo-name>:latest
    healthCheckPath: <health_path>
```

## 3. Health Endpoint Contract

- Expose a fast, zero-DB HTTP `200` endpoint (e.g. `GET /api/ping` or `GET /actuator/health`) that responds in `< 50ms` without waiting on external database connections.
- Bind Spring Boot to `${PORT:8080}` so Render's dynamic port injection works out of the box.
