const realKill = process.kill.bind(process);

process.kill = ((pid, signal) => {
  if (pid < 0 && signal !== 0) {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  }
  return realKill(pid, signal);
});
