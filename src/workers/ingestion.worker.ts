function shutdown(signal: string, keepAlive: NodeJS.Timeout): void {
  console.log(`Ingestion worker received ${signal}, shutting down`);
  clearInterval(keepAlive);
  process.exit(0);
}

function main(): void {
  const keepAlive = setInterval(() => {
    // Hold the process open until a shutdown signal is received.
  }, 60_000);

  process.on('SIGTERM', () => shutdown('SIGTERM', keepAlive));
  process.on('SIGINT', () => shutdown('SIGINT', keepAlive));

  console.log('Ingestion worker started');
}

main();
