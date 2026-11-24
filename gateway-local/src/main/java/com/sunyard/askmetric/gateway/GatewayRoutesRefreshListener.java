package com.sunyard.askmetric.gateway;

import org.springframework.cloud.context.scope.refresh.RefreshScopeRefreshedEvent;
import org.springframework.cloud.gateway.event.RefreshRoutesEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Component;

/** Nacos 配置刷新后通知 Gateway 重新读取路由定义。 */
@Component
public class GatewayRoutesRefreshListener implements ApplicationListener<RefreshScopeRefreshedEvent> {

    private final ApplicationEventPublisher eventPublisher;

    public GatewayRoutesRefreshListener(ApplicationEventPublisher eventPublisher) {
        this.eventPublisher = eventPublisher;
    }

    @Override
    public void onApplicationEvent(RefreshScopeRefreshedEvent event) {
        eventPublisher.publishEvent(new RefreshRoutesEvent(this));
    }
}
