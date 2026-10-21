import { fakeMicSenderVar, writeFakeMic } from './fake-mic';

export default function globalSetup() {
  for (const profile of ['audible', 'ultrasonic'] as const) process.env[fakeMicSenderVar(profile)] = writeFakeMic(profile);
}
