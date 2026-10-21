import { FAKE_MIC_SENDER, writeFakeMic } from './fake-mic';

export default function globalSetup() {
  process.env[FAKE_MIC_SENDER] = writeFakeMic();
}
