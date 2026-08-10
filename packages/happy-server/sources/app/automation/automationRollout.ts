const ENV_NAME = 'HAPPY_SERVER_BACKED_AUTOMATION_ACCOUNTS';

export function isServerBackedAutomationEnabled(
    accountId: string,
    configuredAccounts: string | undefined = process.env[ENV_NAME],
): boolean {
    if (!configuredAccounts) return false;
    const accounts = configuredAccounts.split(',').map((value) => value.trim()).filter(Boolean);
    return accounts.includes('*') || accounts.includes(accountId);
}
