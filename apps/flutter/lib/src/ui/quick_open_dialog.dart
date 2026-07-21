part of 't4_app.dart';

final class _QuickOpenDialog extends StatefulWidget {
  const _QuickOpenDialog({required this.actions});

  final T4Actions actions;

  @override
  State<_QuickOpenDialog> createState() => _QuickOpenDialogState();
}

final class _QuickOpenDialogState extends State<_QuickOpenDialog> {
  final TextEditingController _queryController = TextEditingController();
  final FocusNode _queryFocus = FocusNode(debugLabel: 'Quick open query');
  Timer? _debounce;
  int _requestGeneration = 0;
  List<String> _paths = const <String>[];
  bool _loading = false;
  bool _truncated = false;
  String? _error;

  @override
  void dispose() {
    _debounce?.cancel();
    _queryController.dispose();
    _queryFocus.dispose();
    super.dispose();
  }

  void _scheduleSearch(String value) {
    _debounce?.cancel();
    final query = value.trim();
    if (query.isEmpty) {
      _requestGeneration += 1;
      setState(() {
        _paths = const <String>[];
        _loading = false;
        _truncated = false;
        _error = null;
      });
      return;
    }
    _requestGeneration += 1;
    setState(() {
      _paths = const <String>[];
      _loading = true;
      _truncated = false;
      _error = null;
    });
    _debounce = Timer(const Duration(milliseconds: 220), () {
      unawaited(_search(query));
    });
  }

  Future<void> _search(String query) async {
    final generation = ++_requestGeneration;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await widget.actions.searchProjectFiles(query);
      if (!mounted || generation != _requestGeneration) return;
      setState(() {
        _paths = result.paths;
        _truncated = result.truncated;
        _loading = false;
      });
    } on Object {
      if (!mounted || generation != _requestGeneration) return;
      setState(() {
        _paths = const <String>[];
        _truncated = false;
        _loading = false;
        _error = 'Project search failed. Try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final query = _queryController.text.trim();
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620, maxHeight: 560),
        child: Padding(
          padding: const EdgeInsets.all(_T4Space.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Quick open',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    tooltip: 'Close quick open',
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const SizedBox(height: _T4Space.sm),
              TextField(
                controller: _queryController,
                focusNode: _queryFocus,
                autofocus: true,
                onChanged: _scheduleSearch,
                onSubmitted: (value) {
                  _debounce?.cancel();
                  final normalized = value.trim();
                  if (normalized.isNotEmpty) unawaited(_search(normalized));
                },
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  labelText: 'Find a project file',
                  hintText: 'Type part of a file name or path',
                ),
              ),
              const SizedBox(height: _T4Space.sm),
              if (_loading) const LinearProgressIndicator(),
              if (_error case final error?) ...[
                const SizedBox(height: _T4Space.sm),
                Text(
                  error,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              Flexible(
                child: query.isEmpty
                    ? const _QuickOpenMessage(
                        icon: Icons.keyboard_outlined,
                        message: 'Start typing to search this project.',
                      )
                    : !_loading && _error == null && _paths.isEmpty
                    ? const _QuickOpenMessage(
                        icon: Icons.search_off_outlined,
                        message: 'No matching project files.',
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        itemCount: _paths.length,
                        itemBuilder: (context, index) {
                          final path = _paths[index];
                          return ListTile(
                            leading: const Icon(
                              Icons.insert_drive_file_outlined,
                            ),
                            title: Text(
                              path.split('/').last,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: Text(
                              path,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            onTap: () => Navigator.pop(context, path),
                          );
                        },
                      ),
              ),
              if (_truncated)
                const Padding(
                  padding: EdgeInsets.only(top: _T4Space.sm),
                  child: Text(
                    'More matches exist. Keep typing to narrow the list.',
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _QuickOpenMessage extends StatelessWidget {
  const _QuickOpenMessage({required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(_T4Space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: Theme.of(context).colorScheme.onSurfaceVariant),
            const SizedBox(height: _T4Space.sm),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
