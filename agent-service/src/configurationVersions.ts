/** 不含正文或凭据的不可变资源引用；只由已授权的内部测评调用或持久请求关联指定。 */
export interface ConfigurationVersions {
  agentRuntimeVersion: string;
  businessSkillVersion: string;
  inquiryTopicVersion?: string;
}
