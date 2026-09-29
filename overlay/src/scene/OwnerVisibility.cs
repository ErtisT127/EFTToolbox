using EFTToolbox.Contracts;

namespace EFTToolbox.Overlay;

/// <summary>
/// The shared owner-visibility rule. The authoritative implementation is
/// dashboard/src/pages/map/lib/annotations.ts (ownerVisibleFor); this is the overlay's mirror of it,
/// and --owner-visibility-self-check exercises the same matrix. A manual hide always wins, your own
/// markers always render unless you hid them yourself, explicitly shown owners render, room members
/// default visible, departed owners default hidden. No identity means nothing is filtered.
/// </summary>
internal sealed class OwnerVisibility
{
    internal static readonly OwnerVisibility ShowAll = new("", [], [], []);

    private readonly string selfId;
    private readonly HashSet<string> active;
    private readonly HashSet<string> hidden;
    private readonly HashSet<string> shown;

    internal OwnerVisibility(string selfId, IEnumerable<string> activeOwners, IEnumerable<string> hiddenOwners, IEnumerable<string> shownOwners)
    {
        this.selfId = selfId ?? "";
        active = [.. activeOwners ?? []];
        hidden = [.. hiddenOwners ?? []];
        shown = [.. shownOwners ?? []];
    }

    internal static OwnerVisibility From(string ownerId, MultiplayerStatus? status, MarkerPreferences? preferences) => new(
        ownerId,
        (status?.Members ?? []).Select(member => member.PeerId),
        preferences?.HiddenOwners ?? [],
        preferences?.ShownOwners ?? []);

    internal bool Allows(string ownerId) =>
        selfId.Length == 0
        || (!hidden.Contains(ownerId) && (ownerId == selfId || shown.Contains(ownerId) || active.Contains(ownerId)));
}
