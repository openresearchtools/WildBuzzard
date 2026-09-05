/* SPDX-License-Identifier: AGPL-3.0-or-later */

#include "WildBuzzardCommandLine.h"

#include <algorithm>
#include <chrono>
#include <iterator>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "json/json.h"

namespace {

constexpr size_t kMaxRequestBytes = 8 * 1024 * 1024;
constexpr size_t kMaxResponseBytes = 64 * 1024 * 1024;
using Clock = std::chrono::steady_clock;

constexpr const char* kCommands[] = {
    "help",
    "h",
    "version",
    "tools",
    "skill",
    "status",
    "open",
    "tabs",
    "tab_groups",
    "history",
    "bookmarks",
    "navigate",
    "snapshot",
    "diff",
    "act",
    "download",
    "upload",
    "read",
    "grep",
    "list_console_messages",
    "clear_console_messages",
    "list_network_requests",
    "get_network_request",
    "enable_debugger",
    "list_scripts",
    "get_script_source",
    "set_logpoint",
    "remove_logpoint",
    "get_logpoint_results",
    "screenshot",
    "pdf",
    "wait",
    "windows",
    "evaluate",
    "gecko_render",
    "torrent_list",
    "torrent_details",
    "torrent_control",
    "torrent_add",
    "onion_auth",
    "run",
    "devtools",
    "console",
    "network",
    "request",
    "debugger",
    "scripts",
    "script_source",
    "logpoint_set",
    "logpoint_remove",
    "logpoint_results",
    "render",
    "back",
    "forward",
    "reload",
    "click",
    "click_at",
    "type",
    "type_at",
    "fill",
    "press",
    "hover",
    "hover_at",
    "focus",
    "check",
    "uncheck",
    "select",
    "scroll",
    "drag",
    "drag_at",
    "dialog_accept",
    "dialog_dismiss",
};

class FileDescriptor {
 public:
  explicit FileDescriptor(int fd = -1) : mFd(fd) {}
  ~FileDescriptor() { Reset(); }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  int Get() const { return mFd; }
  int Release() {
    int fd = mFd;
    mFd = -1;
    return fd;
  }
  void Reset(int fd = -1) {
    if (mFd >= 0) {
      close(mFd);
    }
    mFd = fd;
  }

 private:
  int mFd;
};

std::string Env(const char* name) {
  const char* value = getenv(name);
  return value ? value : "";
}

std::string CommandName(int argc, char* argv[]) {
  for (int i = 1; i < argc; ++i) {
    std::string argument = argv[i];
    if (argument == "--json" || argument == "--no-start") {
      continue;
    }
    if (argument == "--cwd" || argument == "--session" ||
        argument == "--input") {
      ++i;
      continue;
    }
    if (argument.rfind("--cwd=", 0) == 0 ||
        argument.rfind("--session=", 0) == 0 ||
        argument.rfind("--input=", 0) == 0) {
      continue;
    }
    if (argument.empty() || argument[0] == '-') {
      return "";
    }
    std::replace(argument.begin(), argument.end(), '-', '_');
    return argument;
  }
  return "";
}

bool HasArgument(int argc, char* argv[], const char* value) {
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], value)) {
      return true;
    }
  }
  return false;
}

bool IsAbsolutePath(const std::string& path) {
  if (path == "/") {
    return true;
  }
  if (path.empty() || path[0] != '/' || path.back() == '/') {
    return false;
  }
  for (size_t start = 1; start < path.size();) {
    size_t end = path.find('/', start);
    auto component = path.substr(start, end - start);
    if (component.empty() || component == "." || component == "..") {
      return false;
    }
    if (end == std::string::npos) {
      break;
    }
    start = end + 1;
  }
  return std::none_of(path.begin(), path.end(),
                      [](unsigned char c) { return c <= 0x1f || c == 0x7f; });
}

bool SocketTarget(std::string& path, bool& explicitPath, std::string& error) {
  path = Env("WILDBUZZARD_CONTROL_SOCKET");
  explicitPath = !path.empty();
  if (explicitPath) {
    if (!IsAbsolutePath(path) || path == "/") {
      error = "WILDBUZZARD_CONTROL_SOCKET must be a normalized absolute path";
      return false;
    }
    return true;
  }
  auto runtime = Env("XDG_RUNTIME_DIR");
  if (IsAbsolutePath(runtime)) {
    path = runtime + "/wildbuzzard/profiles";
    return true;
  }
  auto state = Env("XDG_STATE_HOME");
  if (!IsAbsolutePath(state)) {
    auto home = Env("HOME");
    if (!IsAbsolutePath(home)) {
      error = "HOME must be a normalized absolute path";
      return false;
    }
    state = home + "/.local/state";
  }
  path = state + "/wildbuzzard/run/profiles";
  return true;
}

bool IsSocketName(const std::string& name) {
  if (name.size() != 50 || name.substr(0, 8) != "control-" || name[32] != '-' ||
      name.substr(45) != ".sock") {
    return false;
  }
  for (size_t i = 8; i < 32; ++i) {
    char c = name[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  for (size_t i = 33; i < 45; ++i) {
    char c = name[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') || c == '_' || c == '-')) {
      return false;
    }
  }
  return true;
}

bool PrivateDirectory(const std::string& path, bool allowMissing,
                      std::string& error) {
  struct stat info;
  if (lstat(path.c_str(), &info) < 0) {
    if (allowMissing && errno == ENOENT) {
      return true;
    }
    error =
        "could not inspect control directory " + path + ": " + strerror(errno);
    return false;
  }
  if (!S_ISDIR(info.st_mode) || info.st_uid != geteuid() ||
      (info.st_mode & 0077)) {
    error =
        "Wild Buzzard control directory must be owned by this user and "
        "private: " +
        path;
    return false;
  }
  return true;
}

bool WaitForSocket(int fd, short events, Clock::time_point deadline,
                   std::string& error) {
  while (true) {
    auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                         deadline - Clock::now())
                         .count();
    if (remaining <= 0) {
      error = "timed out waiting for Wild Buzzard";
      return false;
    }
    pollfd item{fd, events, 0};
    int result = poll(&item, 1, int(remaining));
    if (result > 0) {
      return true;
    }
    if (result < 0 && errno != EINTR) {
      error =
          "could not wait for Wild Buzzard: " + std::string(strerror(errno));
      return false;
    }
  }
}

int ConnectSocket(const std::string& path, std::string& error) {
  sockaddr_un address{};
  if (path.size() >= sizeof(address.sun_path)) {
    error = "Wild Buzzard control socket path is too long: " + path;
    return -1;
  }
  struct stat info;
  if (lstat(path.c_str(), &info) < 0) {
    if (errno != ENOENT) {
      error =
          "could not inspect control socket: " + std::string(strerror(errno));
    }
    return -1;
  }
  if (!S_ISSOCK(info.st_mode) || info.st_uid != geteuid() ||
      (info.st_mode & 0077)) {
    error =
        "Wild Buzzard control socket must be owned by this user and private: " +
        path;
    return -1;
  }
  FileDescriptor socketFd(
      socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0));
  if (socketFd.Get() < 0) {
    error = "could not create control socket: " + std::string(strerror(errno));
    return -1;
  }
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path.c_str(), path.size() + 1);
  int result = connect(socketFd.Get(), reinterpret_cast<sockaddr*>(&address),
                       sizeof(address));
  if (result < 0 && errno == EINPROGRESS) {
    if (!WaitForSocket(socketFd.Get(), POLLOUT,
                       Clock::now() + std::chrono::seconds(1), error)) {
      return -1;
    }
    int status = 0;
    socklen_t length = sizeof(status);
    if (getsockopt(socketFd.Get(), SOL_SOCKET, SO_ERROR, &status, &length) <
        0) {
      status = errno;
    }
    result = status ? -1 : 0;
    errno = status;
  }
  if (result < 0) {
    if (errno != ENOENT && errno != ECONNREFUSED) {
      error =
          "could not connect to Wild Buzzard: " + std::string(strerror(errno));
    }
    return -1;
  }
  return socketFd.Release();
}

int ConnectExisting(const std::string& target, bool explicitPath,
                    std::string& error) {
  auto directory = explicitPath ? target.substr(0, target.rfind('/')) : target;
  if (directory.empty()) {
    directory = "/";
  }
  if (!PrivateDirectory(directory, !explicitPath, error)) {
    return -1;
  }
  if (explicitPath) {
    return ConnectSocket(target, error);
  }
  auto closeDirectory = [](DIR* directory) { closedir(directory); };
  std::unique_ptr<DIR, decltype(closeDirectory)> entries(
      opendir(target.c_str()), closeDirectory);
  if (!entries) {
    if (errno != ENOENT) {
      error = "could not list control sockets: " + std::string(strerror(errno));
    }
    return -1;
  }
  std::vector<std::string> paths;
  while (dirent* entry = readdir(entries.get())) {
    if (IsSocketName(entry->d_name)) {
      paths.push_back(target + "/" + entry->d_name);
    }
  }
  std::sort(paths.begin(), paths.end());
  FileDescriptor selected;
  std::string connected;
  size_t count = 0;
  for (const auto& path : paths) {
    FileDescriptor candidate(ConnectSocket(path, error));
    if (!error.empty()) {
      return -1;
    }
    if (candidate.Get() >= 0) {
      selected.Reset(candidate.Release());
      connected += (count++ ? ", " : "") + path;
    }
  }
  if (count > 1) {
    error =
        "multiple Wild Buzzard profiles are running; set "
        "WILDBUZZARD_CONTROL_SOCKET to one of: " +
        connected;
    return -1;
  }
  return selected.Release();
}

bool LaunchBrowser(std::string& error) {
  int pipeFds[2];
  if (pipe2(pipeFds, O_CLOEXEC) < 0) {
    error =
        "could not create browser launch pipe: " + std::string(strerror(errno));
    return false;
  }
  FileDescriptor input(pipeFds[0]);
  FileDescriptor output(pipeFds[1]);
  pid_t child = fork();
  if (child == 0) {
    input.Reset();
    pid_t browser = fork();
    if (browser == 0) {
      setsid();
      int nullFd = open("/dev/null", O_RDWR);
      if (nullFd >= 0) {
        dup2(nullFd, STDIN_FILENO);
        dup2(nullFd, STDOUT_FILENO);
        dup2(nullFd, STDERR_FILENO);
        if (nullFd > STDERR_FILENO) {
          close(nullFd);
        }
        execl("/proc/self/exe", "wildbuzzard", nullptr);
      }
    }
    if (browser <= 0) {
      int status = errno;
      ssize_t ignored = write(output.Get(), &status, sizeof(status));
      (void)ignored;
    }
    _exit(browser < 0 ? 1 : 0);
  }
  if (child < 0) {
    error = "could not launch Wild Buzzard: " + std::string(strerror(errno));
    return false;
  }
  output.Reset();
  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {
  }
  int launchError = 0;
  ssize_t count;
  do {
    count = read(input.Get(), &launchError, sizeof(launchError));
  } while (count < 0 && errno == EINTR);
  if (count != 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    error = "could not launch Wild Buzzard: " +
            std::string(strerror(launchError ? launchError : EIO));
    return false;
  }
  return true;
}

std::string Encode(const Json::Value& value) {
  Json::StreamWriterBuilder writer;
  writer["indentation"] = "";
  return Json::writeString(writer, value) + "\n";
}

bool ReadStdin(std::string& source, std::string& error) {
  char buffer[8192];
  while (true) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count == 0) {
      return true;
    }
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      error = "could not read stdin: " + std::string(strerror(errno));
      return false;
    }
    source.append(buffer, count);
    if (source.size() > kMaxRequestBytes) {
      error = "stdin exceeds the Wild Buzzard request limit";
      return false;
    }
  }
}

bool Exchange(int fd, const std::string& request, Json::Value& response,
              std::string& error) {
  auto deadline = Clock::now() + std::chrono::seconds(65);
  for (size_t sent = 0; sent < request.size();) {
    if (!WaitForSocket(fd, POLLOUT, deadline, error)) {
      return false;
    }
    ssize_t count =
        send(fd, request.data() + sent, request.size() - sent, MSG_NOSIGNAL);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) {
      continue;
    }
    if (count <= 0) {
      error = "could not send the Wild Buzzard command";
      return false;
    }
    sent += count;
  }
  std::string source;
  char buffer[8192];
  while (true) {
    if (!WaitForSocket(fd, POLLIN, deadline, error)) {
      return false;
    }
    ssize_t count = recv(fd, buffer, sizeof(buffer), 0);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) {
      continue;
    }
    if (count <= 0) {
      error = "Wild Buzzard closed the connection without a complete response";
      return false;
    }
    source.append(buffer, count);
    if (source.size() > kMaxResponseBytes) {
      error = "Wild Buzzard response exceeded its limit";
      return false;
    }
    if (source.find('\n') != std::string::npos) {
      break;
    }
  }
  Json::CharReaderBuilder builder;
  Json::CharReaderBuilder::strictMode(&builder.settings_);
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  if (!reader->parse(source.data(), source.data() + source.size(), &response,
                     &error) ||
      !response.isObject() || !response["exitCode"].isUInt() ||
      response["exitCode"].asUInt() > 255 || !response["stdout"].isString() ||
      !response["stderr"].isString()) {
    error = "invalid response from Wild Buzzard";
    return false;
  }
  return true;
}

bool Call(int argc, char* argv[], const std::string& command,
          Json::Value& response, std::string& error) {
  if (argc > 4097) {
    error = "too many Wild Buzzard command arguments";
    return false;
  }
  std::string target;
  bool explicitPath;
  if (!SocketTarget(target, explicitPath, error)) {
    return false;
  }
  const char* noStart = getenv("WILDBUZZARD_NO_START");
  bool start = !HasArgument(argc, argv, "--no-start") &&
               (!noStart || !strcmp(noStart, "0"));
  Json::Value request(Json::objectValue);
  request["version"] = 1;
  request["argv"] = Json::Value(Json::arrayValue);
  bool readStdin = false;
  for (int i = 1; i < argc; ++i) {
    request["argv"].append(argv[i]);
    readStdin |= !strcmp(argv[i], "--input=-") ||
                 (!strcmp(argv[i], "--input") && i + 1 < argc &&
                  !strcmp(argv[i + 1], "-"));
  }
  std::unique_ptr<char, decltype(&free)> cwd(getcwd(nullptr, 0), free);
  if (!cwd) {
    error = "could not resolve the working directory";
    return false;
  }
  request["cwd"] = cwd.get();
  if (readStdin) {
    std::string input;
    if (!ReadStdin(input, error)) {
      return false;
    }
    request["stdin"] = input;
  }
  auto source = Encode(request);
  if (source.size() > kMaxRequestBytes) {
    error = "Wild Buzzard command request is too large";
    return false;
  }
  FileDescriptor connection(ConnectExisting(target, explicitPath, error));
  if (!error.empty()) {
    return false;
  }
  if (connection.Get() < 0 && command == "status" && !start) {
    Json::Value status(Json::objectValue);
    status["running"] = false;
    status["socketPath"] = target;
    status["transport"] = "unix";
    status["runtime"] = "gecko";
    response["exitCode"] = 0;
    response["stdout"] = Encode(status);
    response["stderr"] = "";
    return true;
  }
  if (connection.Get() < 0) {
    if (!start) {
      error = "Wild Buzzard is not running";
      return false;
    }
    if (!LaunchBrowser(error)) {
      return false;
    }
    auto deadline = Clock::now() + std::chrono::seconds(30);
    while (connection.Get() < 0 && Clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      connection.Reset(ConnectExisting(target, explicitPath, error));
      if (!error.empty()) {
        return false;
      }
    }
    if (connection.Get() < 0) {
      error = "Wild Buzzard did not expose native control at " + target +
              ": timed out";
      return false;
    }
  }
  return Exchange(connection.Get(), source, response, error);
}

}  // namespace

bool HandleWildBuzzardCommandLine(int argc, char* argv[], int& exitCode) {
  auto command = CommandName(argc, argv);
  if (std::none_of(std::begin(kCommands), std::end(kCommands),
                   [&](const char* name) { return command == name; })) {
    return false;
  }
  Json::Value response;
  std::string error;
  if (!Call(argc, argv, command, response, error)) {
    if (HasArgument(argc, argv, "--json")) {
      Json::Value value(Json::objectValue);
      value["ok"] = false;
      value["error"] = error;
      fputs(Encode(value).c_str(), stderr);
    } else {
      fprintf(stderr, "wildbuzzard: %s\n", error.c_str());
    }
    exitCode = 1;
    return true;
  }
  auto output = response["stdout"].asString();
  auto diagnostic = response["stderr"].asString();
  bool written =
      fwrite(output.data(), 1, output.size(), stdout) == output.size();
  written &= fwrite(diagnostic.data(), 1, diagnostic.size(), stderr) ==
             diagnostic.size();
  written &= fflush(stdout) == 0;
  written &= fflush(stderr) == 0;
  exitCode = written ? int(response["exitCode"].asUInt()) : 1;
  return true;
}
