/**
 * Memory-only Microsoft authentication for the local Work IQ provider.
 */
import { randomUUID } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import {
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
  type InteractiveRequest,
  type SilentFlowRequest,
} from '@azure/msal-node';

const WORK_IQ_SCOPE = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AuthenticationResult = {
  accessToken: string;
  tenantId: string;
  account: AccountInfo | null;
};

type MicrosoftAuthenticationClient = {
  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult>;
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult>;
};

type StandardCopilotTokenProviderInput = {
  tenantId: string;
  clientId: string;
  openBrowser: (url: string) => Promise<void>;
};

type StandardCopilotTokenProviderDependencies = {
  createClient(config: Configuration): MicrosoftAuthenticationClient;
};

export type StandardCopilotTokenProvider = {
  getAccessToken(): Promise<string>;
};

export class StandardCopilotAuthError extends Error {}

export async function writePrivateAuthUrlHandoff(filePath: string, url: string): Promise<void> {
  await writeFile(filePath, url, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
}

const defaultDependencies: StandardCopilotTokenProviderDependencies = {
  createClient: (config) => {
    const client = new PublicClientApplication(config);
    return {
      acquireTokenInteractive: async (request) => {
        const result = await client.acquireTokenInteractive(request);
        return result;
      },
      acquireTokenSilent: async (request) => {
        const result = await client.acquireTokenSilent(request);
        return result;
      },
    };
  },
};

export function createStandardCopilotTokenProvider(
  input: StandardCopilotTokenProviderInput,
  dependencies: StandardCopilotTokenProviderDependencies = defaultDependencies,
): StandardCopilotTokenProvider {
  if (!UUID_PATTERN.test(input.tenantId) || !UUID_PATTERN.test(input.clientId)) {
    throw new StandardCopilotAuthError(
      'WORKIQ_TENANT_ID와 WORKIQ_CLIENT_ID에 테스트 앱의 UUID를 지정하세요.',
    );
  }

  const client = dependencies.createClient({
    auth: {
      clientId: input.clientId,
      authority: `https://login.microsoftonline.com/${input.tenantId}`,
    },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
  let account: AccountInfo | null = null;

  const acceptResult = (result: AuthenticationResult): string => {
    if (!result.accessToken || result.tenantId.toLowerCase() !== input.tenantId.toLowerCase()) {
      throw new StandardCopilotAuthError('테스트 테넌트의 Microsoft 사용자 인증 결과가 아닙니다.');
    }
    account = result.account;
    return result.accessToken;
  };

  const authenticateInteractively = async (): Promise<string> => {
    try {
      const result = await client.acquireTokenInteractive({
        scopes: [WORK_IQ_SCOPE],
        nonce: randomUUID(),
        state: randomUUID(),
        openBrowser: input.openBrowser,
        successTemplate: '<html lang="ko"><meta charset="utf-8"><p>Microsoft 로그인이 완료되었습니다. SayCode 대화로 돌아가세요.</p></html>',
        errorTemplate: '<html lang="ko"><meta charset="utf-8"><p>Microsoft 로그인을 완료하지 못했습니다.</p></html>',
      });
      return acceptResult(result);
    } catch (error) {
      if (error instanceof StandardCopilotAuthError) throw error;
      throw new StandardCopilotAuthError(
        'Microsoft 사용자 로그인 실패. 앱 등록·권한 동의·로그인 계정을 확인하세요.',
      );
    }
  };

  return {
    async getAccessToken() {
      if (account) {
        try {
          return acceptResult(await client.acquireTokenSilent({
            account,
            scopes: [WORK_IQ_SCOPE],
          }));
        } catch {
          account = null;
        }
      }
      return authenticateInteractively();
    },
  };
}
