const ENV_NAME = 'SAYCODE_AUTOMATION_ENABLED';

export function isServerBackedAutomationEnabled(
    configuredValue: string | undefined = process.env[ENV_NAME],
): boolean {
    return configuredValue === 'true';
}
