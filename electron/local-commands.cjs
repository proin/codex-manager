'use strict';

// macOS ships Universal OpenSSH tools. Their absolute paths avoid selecting
// Intel-only installations from a user's PATH on Apple Silicon.
function sshExecutable(platform = process.platform) {
  return platform === 'darwin' ? '/usr/bin/ssh' : 'ssh';
}

function keygenExecutable(platform = process.platform) {
  return platform === 'darwin' ? '/usr/bin/ssh-keygen' : 'ssh-keygen';
}

module.exports = { sshExecutable, keygenExecutable };
