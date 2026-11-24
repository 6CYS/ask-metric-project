FROM maven:3.9.13-eclipse-temurin-17 AS builder

WORKDIR /build
COPY pom.xml .
RUN mvn -B -ntp dependency:go-offline
COPY src ./src
RUN mvn -B -ntp package -DskipTests

FROM eclipse-temurin:17-jre

WORKDIR /app
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC -Dfile.encoding=UTF-8"
COPY --from=builder /build/target/ask-metric-intent-gateway-local-0.1.0-SNAPSHOT.jar /app/gateway.jar
RUN groupadd --system app && useradd --system --gid app app
USER app
EXPOSE 9000 18080
ENTRYPOINT ["java", "-jar", "/app/gateway.jar"]
