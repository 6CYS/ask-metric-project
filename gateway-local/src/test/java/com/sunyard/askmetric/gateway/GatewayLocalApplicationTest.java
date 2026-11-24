package com.sunyard.askmetric.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        properties = {
                "spring.cloud.nacos.config.enabled=false",
                "spring.cloud.nacos.discovery.enabled=false",
                "spring.config.import=optional:nacos:"
        }
)
@ActiveProfiles("test")
class GatewayLocalApplicationTest {

    @Test
    void loadsGatewayContextWithoutNacos() {
        assertThat(true).isTrue();
    }
}
