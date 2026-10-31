import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { appSession } from "../lib/app-session";

export default eveChannel({ auth: [appSession, localDev()] });
