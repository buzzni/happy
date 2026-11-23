import { ApiClient as SessionApiClient } from './api';
import { ApiMachineClient } from './apiMachine';
import type { Machine, DaemonState } from './types';
import type { createDeviceEnrollment } from '@/daemon/deviceEnrollment';
import type { DeviceKeys } from '@/daemon/deviceKeys';
import type { CommonHandlerOptions } from '@/modules/common/registerCommonHandlers';
import type { LegacyDispatchReservation } from '@/utils/workspaceTurnAdmission';
import type { Credentials } from '@/persistence';
import type { ManagedAttachment } from '@/managed/managedSessionAttach';

// Only the daemon and library entry need the synchronous machine RPC factory.
export class ApiClient extends SessionApiClient {
  // Library callers can also pass these factories as standalone callbacks.
  static override create: (credential: Credentials) => Promise<ApiClient> = (SessionApiClient.create<typeof ApiClient>).bind(ApiClient);
  static override managed: (attachment: ManagedAttachment) => ApiClient = (SessionApiClient.managed<typeof ApiClient>).bind(ApiClient);
  static override managedMachine: (input: Parameters<typeof SessionApiClient.managedMachine>[0]) => ApiClient = (SessionApiClient.managedMachine<typeof ApiClient>).bind(ApiClient);

  machineSyncClient(machine: Machine, deviceKeys?: DeviceKeys, deviceEnrollment?: ReturnType<typeof createDeviceEnrollment>, processState?: DaemonState,
    withFilesystemMutation?: CommonHandlerOptions['withFilesystemMutation'], admitSubprocess?: CommonHandlerOptions['admitSubprocess'],
    reserveLegacyDispatch?: (roots: readonly string[]) => Promise<LegacyDispatchReservation>): ApiMachineClient {
    return withFilesystemMutation || admitSubprocess || reserveLegacyDispatch
      ? new ApiMachineClient(this.bearer(), machine, deviceKeys, deviceEnrollment, processState, withFilesystemMutation, admitSubprocess, reserveLegacyDispatch)
      : new ApiMachineClient(this.bearer(), machine, deviceKeys, deviceEnrollment, processState);
  }
}
