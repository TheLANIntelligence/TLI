import { Redirect } from 'expo-router';

// Keep the root URL as a landing alias; /ask owns the only Chat controller.
export default function PairedLanding() { return <Redirect href="/ask" />; }
